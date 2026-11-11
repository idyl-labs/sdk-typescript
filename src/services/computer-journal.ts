// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

/*
 * A Computer's journal is its history. A private session records no
 * entry, and a notebook
 * session's Cell is listed through its notebook. Anyone who may read the
 * Computer may read its whole journal, including entries other identities
 * caused. Every journal call addresses the Computer by
 * name or by its stable identity, as the session calls do, on the Subnet the
 * client's placement resolves to.
 */
import { TransportError } from "../errors.js";
import type { NamespaceScope } from "../api/types.js";
import {
  decodeJournalEntry,
  decodeJournalPage,
  validateJournalListOptions,
  type ListJournalResponse,
  type JournalEntry,
  type JournalListOptions,
} from "../api/journal.js";
import { computerJournal, computerJournalById } from "../internal/apipath.js";
import type { PlacementContext } from "../internal/context.js";
import { listEnvelope } from "../internal/envelopes.js";
import { computerJournalQuery } from "../internal/listquery.js";
import { requireNonBlank, signalOption } from "../internal/options.js";
import { resolvePlacement } from "../internal/routing.js";
import {
  parseComputerId,
  parseJournalEntryId,
  type JournalEntryId,
} from "../resource/uuid-id.js";

/**
 * One Computer's journal, built from the scope the resolution named; with
 * `entryId`, one entry of it.
 */
export type JournalPath = (
  scope: NamespaceScope,
  entryId?: JournalEntryId,
) => string;

/**
 * The journal of the Computer addressed by name. Throws a `TypeError` when
 * `name` is blank.
 */
export function journalByName(name: string): JournalPath {
  requireNonBlank(name, "computer name");
  return (scope, entryId) => computerJournal(scope, name, entryId);
}

/**
 * The journal of the Computer addressed by its stable identity. Throws a
 * `TypeError` when `id` is not a canonical UUID.
 */
export function journalById(id: string): JournalPath {
  const computerId = parseComputerId(id);
  return (scope, entryId) => computerJournalById(scope, computerId, entryId);
}

/**
 * Reads one page of the journal. The options are judged before any request
 * is sent, and the page is read leniently once its envelope is one.
 */
export async function listJournal(
  context: PlacementContext,
  journal: JournalPath,
  options: JournalListOptions,
  signal: AbortSignal | undefined,
  label = "computer journal",
): Promise<ListJournalResponse> {
  validateJournalListOptions(options);
  const resolved = await resolvePlacement(context, signalOption(signal));
  const response = await context.state.transport.json<unknown>(
    "GET",
    resolved.endpoint,
    `${journal(resolved.scope)}${computerJournalQuery(options)}`,
    signalOption(signal),
  );
  listEnvelope(response, label);
  return decodeJournalPage(response);
}

/**
 * Reads one entry of the journal. A response naming another entry is
 * refused.
 */
export async function getJournalEntry(
  context: PlacementContext,
  journal: JournalPath,
  entryId: string,
  signal: AbortSignal | undefined,
  label = "computer journal",
): Promise<JournalEntry> {
  const id = parseJournalEntryId(entryId);
  const resolved = await resolvePlacement(context, signalOption(signal));
  const entry = decodeJournalEntry(
    await context.state.transport.json<unknown>(
      "GET",
      resolved.endpoint,
      journal(resolved.scope, id),
      signalOption(signal),
    ),
  );
  if (entry.id !== id) {
    throw new TransportError(
      "invalid_response",
      `read ${label} entry response names a different entry`,
    );
  }
  return entry;
}
