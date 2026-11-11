// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

use super::*;

fn frame(kind: u8, sid: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![kind];
    out.extend_from_slice(&sid.to_be_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

/// Splits sent bytes into (type, sid, payload) frames.
fn frames(mut bytes: &[u8]) -> Vec<(u8, u32, Vec<u8>)> {
    let mut out = Vec::new();
    while !bytes.is_empty() {
        let kind = bytes[0];
        let sid = u32::from_be_bytes(bytes[1..5].try_into().unwrap());
        let len = u32::from_be_bytes(bytes[5..9].try_into().unwrap()) as usize;
        out.push((kind, sid, bytes[9..9 + len].to_vec()));
        bytes = &bytes[9 + len..];
    }
    out
}

// The client opens odd stream ids from 1, announcing each with OPEN_BIDI.
#[test]
fn client_streams_are_odd_and_announced() {
    let mut mux = Mux::new();
    assert_eq!(mux.open(), Ok(1));
    assert_eq!(mux.open(), Ok(3));
    assert_eq!(
        frames(&mux.take_output()),
        vec![(OPEN_BIDI, 1, vec![]), (OPEN_BIDI, 3, vec![])]
    );
}

// Writes become DATA frames of at most MAX_FRAME_PAYLOAD bytes, never past
// the edge's credit; the rest waits for WINDOW.
#[test]
fn writes_respect_the_frame_size_and_the_credit() {
    let mut mux = Mux::new();
    let sid = mux.open().unwrap();
    mux.take_output();
    mux.write(sid, &vec![7u8; INITIAL_WINDOW + 10]).unwrap();
    let sent = frames(&mux.take_output());
    assert!(
        sent.iter()
            .all(|(k, s, p)| *k == DATA && *s == sid && p.len() <= MAX_FRAME_PAYLOAD)
    );
    assert_eq!(
        sent.iter().map(|f| f.2.len()).sum::<usize>(),
        INITIAL_WINDOW
    );
    assert_eq!(mux.unsent(sid), 10);
    mux.receive(&frame(WINDOW, sid, &4u32.to_be_bytes()));
    let sent = frames(&mux.take_output());
    assert_eq!(sent, vec![(DATA, sid, vec![7u8; 4])]);
    assert_eq!(mux.unsent(sid), 6);
}

// FIN follows the queued bytes, never overtakes them.
#[test]
fn fin_follows_queued_bytes() {
    let mut mux = Mux::new();
    let sid = mux.open().unwrap();
    mux.take_output();
    mux.write(sid, b"abc").unwrap();
    mux.finish(sid).unwrap();
    assert_eq!(mux.write(sid, b"x"), Err(MuxError::SendFinished));
    assert_eq!(
        frames(&mux.take_output()),
        vec![(DATA, sid, b"abc".to_vec()), (FIN, sid, vec![])]
    );
}

// Reading grants the edge the same credit back in one WINDOW frame.
#[test]
fn reading_grants_credit_back() {
    let mut mux = Mux::new();
    let sid = mux.open().unwrap();
    mux.take_output();
    mux.receive(&frame(DATA, sid, b"hello"));
    assert_eq!(mux.read(sid, 3), Ok(Some(b"hel".to_vec())));
    assert_eq!(mux.read(sid, 10), Ok(Some(b"lo".to_vec())));
    assert_eq!(mux.read(sid, 10), Ok(Some(vec![])));
    assert_eq!(
        frames(&mux.take_output()),
        vec![(WINDOW, sid, 5u32.to_be_bytes().to_vec())]
    );
}

// The edge's FIN is reported once every byte before it has been read.
#[test]
fn fin_is_reported_after_the_data() {
    let mut mux = Mux::new();
    let sid = mux.open().unwrap();
    let mut input = frame(DATA, sid, b"xy");
    input.extend(frame(FIN, sid, &[]));
    mux.receive(&input);
    assert_eq!(mux.read(sid, 10), Ok(Some(b"xy".to_vec())));
    assert_eq!(mux.read(sid, 10), Ok(None));
}

// Frames split anywhere across receive calls parse the same.
#[test]
fn frames_split_across_reads() {
    let mut mux = Mux::new();
    let sid = mux.open().unwrap();
    let mut input = frame(DATA, sid, b"split me");
    input.extend(frame(FIN, sid, &[]));
    for byte in input {
        mux.receive(&[byte]);
    }
    assert_eq!(mux.read(sid, 100), Ok(Some(b"split me".to_vec())));
    assert_eq!(mux.read(sid, 100), Ok(None));
}

// Data past the granted credit is a protocol violation: the connection is
// closed with the protocol code, never buffered without bound.
#[test]
fn an_overrun_window_closes_the_connection() {
    let mut mux = Mux::new();
    let sid = mux.open().unwrap();
    mux.take_output();
    let chunk = vec![1u8; MAX_FRAME_PAYLOAD];
    for _ in 0..INITIAL_WINDOW / MAX_FRAME_PAYLOAD {
        mux.receive(&frame(DATA, sid, &chunk));
    }
    assert!(mux.closed().is_none());
    mux.receive(&frame(DATA, sid, &[1]));
    assert_eq!(
        mux.closed(),
        Some(&MuxClosed::Protocol("stream overran its window"))
    );
    let sent = frames(&mux.take_output());
    assert_eq!(sent.last().unwrap().0, CLOSE);
    assert_eq!(&sent.last().unwrap().2[..8], &PROTOCOL_CODE.to_be_bytes());
    assert_eq!(mux.read(sid, 1), Err(StreamEnded::Connection));
}

// A frame that declares a payload over the cap closes the connection before
// any of it is buffered.
#[test]
fn an_oversized_frame_closes_the_connection() {
    let mut mux = Mux::new();
    let mut header = vec![DATA];
    header.extend_from_slice(&1u32.to_be_bytes());
    header.extend_from_slice(&((MAX_FRAME_PAYLOAD + 1) as u32).to_be_bytes());
    mux.receive(&header);
    assert!(matches!(mux.closed(), Some(MuxClosed::Protocol(_))));
}

// The edge opens even ids, increasing; anything else is a violation.
#[test]
fn edge_stream_ids_must_be_even_and_increasing() {
    let mut mux = Mux::new();
    mux.receive(&frame(OPEN_UNI, 2, &[]));
    mux.receive(&frame(OPEN_BIDI, 4, &[]));
    assert_eq!(mux.accept(), Some(Incoming::Unidirectional(2)));
    assert_eq!(mux.accept(), Some(Incoming::Bidirectional(4)));
    assert_eq!(mux.write(2, b"x"), Err(MuxError::SendFinished));

    let mut odd = Mux::new();
    odd.receive(&frame(OPEN_BIDI, 3, &[]));
    assert!(matches!(odd.closed(), Some(MuxClosed::Protocol(_))));

    let mut reopened = Mux::new();
    reopened.receive(&frame(OPEN_BIDI, 4, &[]));
    reopened.receive(&frame(OPEN_BIDI, 2, &[]));
    assert!(matches!(reopened.closed(), Some(MuxClosed::Protocol(_))));
}

// Past the accept backlog, a new edge stream is reset and the connection
// stays up.
#[test]
fn the_accept_backlog_sheds_streams_not_the_connection() {
    let mut mux = Mux::new();
    for i in 1..=ACCEPT_BACKLOG as u32 + 1 {
        mux.receive(&frame(OPEN_BIDI, 2 * i, &[]));
    }
    assert!(mux.closed().is_none());
    let shed = 2 * (ACCEPT_BACKLOG as u32 + 1);
    assert_eq!(
        frames(&mux.take_output()),
        vec![(RESET, shed, 0u64.to_be_bytes().to_vec())]
    );
}

// RESET from the edge ends the stream with its code.
#[test]
fn a_reset_ends_the_stream_with_its_code() {
    let mut mux = Mux::new();
    let sid = mux.open().unwrap();
    mux.receive(&frame(RESET, sid, &9u64.to_be_bytes()));
    assert_eq!(
        mux.read(sid, 1),
        Err(StreamEnded::Reset {
            code: 9,
            remote: true
        })
    );
    assert_eq!(mux.write(sid, b"x"), Err(MuxError::UnknownStream));
}

// CLOSE from the edge ends the connection with its code and reason.
#[test]
fn close_from_the_edge_carries_code_and_reason() {
    let mut mux = Mux::new();
    let mut payload = OVERLOADED_CODE.to_be_bytes().to_vec();
    payload.extend_from_slice(b"busy");
    mux.receive(&frame(CLOSE, 0, &payload));
    assert_eq!(
        mux.closed(),
        Some(&MuxClosed::Closed {
            code: OVERLOADED_CODE,
            reason: "busy".into(),
            remote: true
        })
    );
    assert_eq!(mux.open(), Err(MuxError::Closed));
}

// Stream frames on stream 0 and unknown frame types are violations.
#[test]
fn malformed_frames_close_the_connection() {
    for input in [
        frame(DATA, 0, b"x"),
        frame(WINDOW, 1, &[0, 1]),
        frame(RESET, 1, &[0; 7]),
        frame(CLOSE, 0, &[0; 7]),
        frame(0x09, 0, &[]),
    ] {
        let mut mux = Mux::new();
        mux.open().unwrap();
        mux.receive(&input);
        assert!(
            matches!(mux.closed(), Some(MuxClosed::Protocol(_))),
            "{input:?}"
        );
    }
}

// Closing sends queued data first, then CLOSE, and nothing after.
#[test]
fn close_is_the_last_frame() {
    let mut mux = Mux::new();
    let sid = mux.open().unwrap();
    mux.write(sid, b"bye").unwrap();
    mux.close(DRAIN_CODE, "done");
    mux.ping();
    let sent = frames(&mux.take_output());
    assert_eq!(sent.last().unwrap().0, CLOSE);
    assert_eq!(sent[sent.len() - 2], (DATA, sid, b"bye".to_vec()));
}

// A receive-only stream the edge opened stays readable until its FIN has
// been read, even when the FIN arrived with the data.
#[test]
fn an_edge_unidirectional_stream_is_read_to_its_fin() {
    let mut mux = Mux::new();
    let mut input = frame(OPEN_UNI, 2, &[]);
    input.extend(frame(DATA, 2, b"event"));
    input.extend(frame(FIN, 2, &[]));
    mux.receive(&input);
    mux.take_output();
    assert_eq!(mux.accept(), Some(Incoming::Unidirectional(2)));
    assert_eq!(mux.read(2, 100), Ok(Some(b"event".to_vec())));
    mux.take_output();
    assert_eq!(mux.read(2, 100), Ok(None));
}
