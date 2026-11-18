// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! The connection to one Zone service over a client service lane: TLS 1.3
//! with the client certificate to a service whose certificate names exactly
//! the SPIFFE ID the lane was opened to, carrying one byte stream. Sans-IO:
//! [`ServiceLink::receive`] takes the TLS bytes the service sent,
//! [`ServiceLink::take_output`] yields the TLS bytes to send, and the
//! plaintext is a byte pipe whose frames the caller encodes and decodes.
//!
//! The TLS carries no early data and no resumption, and offers no
//! application protocol: the lane stream's header names the profile.

use std::io::{Read, Write};
use std::sync::Arc;

use rustls::pki_types::{CertificateDer, ServerName};
use rustls::{ClientConfig, ClientConnection};

use crate::identity::{ClientIdentity, ClientKey, IdentityVerifier, ServerIdentity};

/// What a service connection needs.
pub struct ServiceConfig {
    /// The TLS server name to send; the service does not read it.
    pub server_name: String,
    /// The trust anchors of the service's certificate, DER.
    pub roots: Vec<CertificateDer<'static>>,
    /// The client certificate chain, leaf first, for the client key.
    pub chain: Vec<CertificateDer<'static>>,
    /// The exact SPIFFE ID the service's certificate must name.
    pub principal: String,
}

/// Why a service connection ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServiceEnded {
    /// The configuration could not be used.
    Config(&'static str),
    /// TLS failed: the service's certificate, the handshake or a record.
    Tls(String),
    /// The service closed the connection.
    Closed,
}

/// Something the caller acts on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServiceEvent {
    /// TLS is established with the service the lane names.
    Established,
    /// The connection ended.
    Ended(ServiceEnded),
}

/// One connection to one Zone service. The plaintext it receives is held
/// until the caller reads it; the client reads no more TLS from the stream
/// until the caller has handled what it read, so the lane stream's receive
/// window bounds what is held.
pub struct ServiceLink {
    conn: ClientConnection,
    out: Vec<u8>,
    inbox: Vec<u8>,
    established: bool,
    ended: bool,
    events: Vec<ServiceEvent>,
}

impl ServiceLink {
    /// Starts the connection. The ClientHello is in the first
    /// [`ServiceLink::take_output`].
    pub fn new(config: ServiceConfig, key: &ClientKey) -> Result<ServiceLink, ServiceEnded> {
        let verifier =
            IdentityVerifier::new(&config.roots, ServerIdentity::Exact(config.principal))
                .map_err(|_| ServiceEnded::Config("service trust anchors"))?;
        let certified = key
            .certified(config.chain)
            .map_err(|_| ServiceEnded::Config("client certificate"))?;
        let mut tls = ClientConfig::builder_with_provider(Arc::new(idyl_tls_provider::provider()))
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|_| ServiceEnded::Config("tls versions"))?
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_client_cert_resolver(Arc::new(ClientIdentity(Arc::new(certified))));
        tls.enable_early_data = false;
        tls.resumption = rustls::client::Resumption::disabled();
        let name = ServerName::try_from(config.server_name)
            .map_err(|_| ServiceEnded::Config("service server name"))?;
        let conn = ClientConnection::new(Arc::new(tls), name)
            .map_err(|e| ServiceEnded::Tls(e.to_string()))?;
        Ok(ServiceLink {
            conn,
            out: Vec::new(),
            inbox: Vec::new(),
            established: false,
            ended: false,
            events: Vec::new(),
        })
    }

    /// The events since the last call, in order.
    pub fn take_events(&mut self) -> Vec<ServiceEvent> {
        std::mem::take(&mut self.events)
    }

    /// Whether the connection has ended.
    pub fn ended(&self) -> bool {
        self.ended
    }

    /// Takes in TLS bytes the service sent.
    pub fn receive(&mut self, mut bytes: &[u8]) {
        while !self.ended && !bytes.is_empty() {
            if let Err(e) = self.conn.read_tls(&mut bytes) {
                return self.end(ServiceEnded::Tls(e.to_string()));
            }
            let state = match self.conn.process_new_packets() {
                Ok(state) => state,
                Err(e) => return self.end(ServiceEnded::Tls(e.to_string())),
            };
            let mut chunk = vec![0u8; state.plaintext_bytes_to_read()];
            if let Err(e) = self.conn.reader().read_exact(&mut chunk) {
                return self.end(ServiceEnded::Tls(e.to_string()));
            }
            self.inbox.extend_from_slice(&chunk);
            if !self.established && !self.conn.is_handshaking() {
                self.established = true;
                self.events.push(ServiceEvent::Established);
            }
            if state.peer_has_closed() {
                return self.end(ServiceEnded::Closed);
            }
        }
    }

    /// Takes the TLS bytes to send to the service.
    pub fn take_output(&mut self) -> Vec<u8> {
        while self.conn.wants_write() {
            if self.conn.write_tls(&mut self.out).is_err() {
                break;
            }
        }
        std::mem::take(&mut self.out)
    }

    /// Queues plaintext for the service; rustls holds what it sends once
    /// the handshake is done.
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), ServiceEnded> {
        if self.ended {
            return Err(ServiceEnded::Closed);
        }
        self.conn
            .writer()
            .write_all(bytes)
            .map_err(|e| ServiceEnded::Tls(e.to_string()))
    }

    /// Whether plaintext the service sent is waiting to be read.
    pub fn has_unread(&self) -> bool {
        !self.inbox.is_empty()
    }

    /// Takes the plaintext the service sent.
    pub fn read(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.inbox)
    }

    /// Ends the connection with a close notify.
    pub fn close(&mut self) {
        if self.ended {
            return;
        }
        self.conn.send_close_notify();
        self.end(ServiceEnded::Closed);
    }

    fn end(&mut self, why: ServiceEnded) {
        if self.ended {
            return;
        }
        self.ended = true;
        self.events.push(ServiceEvent::Ended(why));
    }
}
