// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

//! Drives the fallback/1 client against a peer at the address given as the
//! first argument: three streams of 600 KiB each are echoed (more than two
//! windows, so credit must flow both ways), and the peer's unidirectional
//! stream is read. Prints `ok` and exits 0 on success.

use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use idyl_computer_connection::mux::{Incoming, Mux};

fn main() {
    let address = std::env::args().nth(1).expect("peer address");
    let mut tcp = TcpStream::connect(address).expect("connect");
    tcp.set_nonblocking(true).expect("nonblocking");
    let mut mux = Mux::new();
    let payload: Vec<u8> = (0..600 * 1024).map(|i| (i % 251) as u8).collect();
    let sids: Vec<u32> = (0..3).map(|_| mux.open().expect("open")).collect();
    for &sid in &sids {
        mux.write(sid, &payload).expect("write");
        mux.finish(sid).expect("finish");
    }
    let mut echoed = vec![Vec::new(); sids.len()];
    let mut done = vec![false; sids.len()];
    let mut uni = Vec::new();
    let mut uni_sid = None;
    let mut uni_done = false;
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut buf = vec![0u8; 64 * 1024];
    while !(done.iter().all(|d| *d) && uni_done) {
        assert!(Instant::now() < deadline, "timed out");
        let out = mux.take_output();
        if !out.is_empty() {
            let mut at = 0;
            while at < out.len() {
                match tcp.write(&out[at..]) {
                    Ok(n) => at += n,
                    Err(e) if e.kind() == ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1))
                    }
                    Err(e) => panic!("write: {e}"),
                }
            }
        }
        match tcp.read(&mut buf) {
            Ok(0) => panic!("peer closed: {:?}", mux.closed()),
            Ok(n) => mux.receive(&buf[..n]),
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(1))
            }
            Err(e) => panic!("read: {e}"),
        }
        assert!(mux.closed().is_none(), "closed: {:?}", mux.closed());
        while let Some(incoming) = mux.accept() {
            match incoming {
                Incoming::Unidirectional(sid) => uni_sid = Some(sid),
                Incoming::Bidirectional(sid) => panic!("unexpected stream {sid}"),
            }
        }
        if let Some(sid) = uni_sid.filter(|_| !uni_done) {
            match mux.read(sid, usize::MAX).expect("uni read") {
                Some(bytes) => uni.extend(bytes),
                None => uni_done = true,
            }
        }
        for (i, &sid) in sids.iter().enumerate() {
            if done[i] {
                continue;
            }
            match mux.read(sid, usize::MAX).expect("read") {
                Some(bytes) => echoed[i].extend(bytes),
                None => done[i] = true,
            }
        }
    }
    for e in &echoed {
        assert!(e == &payload, "echo mismatch: {} bytes", e.len());
    }
    assert_eq!(uni, b"edge-hello");
    println!("ok");
}
