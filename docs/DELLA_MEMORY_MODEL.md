# Della memory model

Della's memory is a set of **canonical records in D1**. Search indexes, vectors, and cached answers are derived from them and are never trusted on their own: every hit is re-read ("hydrated") from the canonical row, and tombstoned or retracted records never come back.

## Records

| Table | What it is |
| --- | --- |
| `source_records` | Provenance: one row per captured message (or admin/meeting note). Raw text is encrypted and expires with message retention (`retention_class = raw`). Sensitive spans are redacted unless sensitive memory is enabled. |
| `entities` | People, items, containers, places, projects, organizations, topics, activities, and the owner. Labels are encrypted. `status` is active/merged/deleted. `merged_into` is set for merges. |
| `entity_aliases` | Names for an entity. Exact lookup uses an HMAC **blind index** (`bidx`, key derived from the data key with label `della-blind-index-v1`), so names are searchable without a plaintext index. There is deliberately no plaintext FTS index over sensitive text. |
| `assertions` | Facts with full epistemic labels (below). `extraction_key` is unique, so retries and late jobs can't duplicate or resurrect. |
| `secretary_items` | Promises, waiting-for items, questions, decisions, predictions, accomplishments, checkpoints, ideas, future-self messages, admin, recruiting, interactions, lessons, notes, trips, opportunities, interests. |
| `memory_events` | Audit of memory changes (created, closed, merged, split, deleted) with encrypted detail. |
| `extraction_runs` | Per message: what was saved and what was rejected, and why. Shown in the Memory inbox. |
| `deletion_tombstones` | IDs the owner deleted. Checked on every hydration and re-applied after restore. |
| `index_state`, `semantic_vectors`, `retrieval_evidence` | Derived: index bookkeeping, vectors, and cached evidence for "why?". All replaceable. |

### Assertion fields

- `predicate`: e.g. `located_in`, `not_located_in`, `lent_to`, `attr:birthday`, `pref:<topic>`.
- `object_entity_id` or encrypted `object_value_enc`.
- `evidence_type`: `explicit_report` (you said it), `tentative`, `confirmed_external_record`, `assistant_proposal`.
- `modality`: actual, possible, intended, hypothetical, obligation. `polarity`: affirmative or negated. `attributed_to` is set when someone else said it.
- `effective_from` / `effective_to`: when it was true in the world. `recorded_at`: when Della learned it.
- `status`: `current`, `historical`, `tentative`, `disputed`, `retracted`, `deleted`.
- `excerpt_enc`: the short quoted span that supports the fact. It survives raw-message expiry until you delete the fact.

## Locations

- **Containment** is a graph of `located_in` edges: item → container → container → place, innermost first, with depth capped at 8. Moving a container moves its contents implicitly, because location is computed by walking current edges at query time.
- **Removal** closes the item's current edge. The item no longer follows its old container.
- **Tentative** ("maybe the keys are in the bag") is stored as `tentative` and reported as unconfirmed. It never overwrites a current location.
- **Late reports** ("I left it in the car yesterday") whose effective time predates the current edge are stored as `historical` and don't replace today's location.
- **Absence** ("not in the bag") retracts matching current or tentative edges and records a negated assertion. No new location is invented.
- **Lending and returning** are tracked as `lent_to` edges.
- **Cycles** (box in bag, bag in box) are rejected, and nothing changes.
- **History** lists every placement with start and end times.

## Ambiguity, merge, and split

Names resolve by blind-index exact match first, then by token subset. When more than one entity matches ("charger" with a laptop charger and a phone charger), Della asks which one. It never silently merges or overwrites. Merges are explicit (dashboard), record an exact snapshot, and can be split back. Both are audited in `memory_events`.

## Extraction and validation

The AI planner returns `knowledge` candidates (`src/knowledge/schema.ts`, max 10) in the same strict structured-output call as the actions. Before anything is stored:

- `evidence_span` must be a verbatim substring of the message.
- Names (items, people, organizations) must appear in the message.
- Numbers (metrics, estimates, amounts) must appear in the message, so a model can't invent "50%".
- Sensitive spans (passwords, SSNs, API keys, Luhn-valid card numbers, bank numbers) are skipped unless sensitive memory is explicitly enabled.

Rejections are listed per message in the Memory inbox. "Maybe I'll…" statements don't become promises or tasks.

## Retrieval and grounding

- Typed questions ("where is X", "what's in X", "what did I promise Alex", "who am I waiting on", "what have you learned about me", "resume thesis") are answered deterministically from canonical rows.
- Vague recall uses bounded keyword matching over decrypted canonical records, plus optional semantic candidates (reserved against `semantic_queries` usage). Every hit is hydrated, so a stale or deleted vector cannot surface.
- Each answer stores an **evidence packet** (claim IDs and source IDs). "Why?" shows dated source excerpts, or says the source text is no longer retained.
- Any model-written summary must cite only claim IDs from the packet (`validateCitations`). Otherwise the deterministic answer is used. Unknown entities get "I don't have anything recorded about …".

## Semantic index

The index is optional and off by default. `index_sync` embeds dirty canonical records in batches of 40, skips unchanged content by hash, reserves embedding usage, and upserts to D1 (default, bounded brute-force cosine for hundreds to low thousands of records) or Vectorize (opaque IDs plus type metadata only, no text). The simulated embedding is a hashed bag of words: it finds lexical overlap, not meaning.

## Deletion

"Forget that" (the last captured message), "forget X" (an entity), and the dashboard's per-message delete all work the same way. Canonical rows are blanked or marked deleted and tombstoned first. Then vectors, index state, cached evidence, linked media, and pending jobs are purged. Extraction keys stay reserved, so a late or retried extraction job adds nothing. Provider-held copies and existing backups are outside Della's reach, and Della says so.

## Off-record and capture pause

- "Don't store this: …" handles the rest of the message operationally (reminders still work), stores no extraction output, and removes the raw text and conversation-log entry after replying. Alone, it deletes what the previous message saved.
- "Pause memory" (24 hours by default) stops capture. Each memorable message during the pause gets a short "Memory is paused" reply.
- With memory off, a one-time note explains how to enable it. Extraction output is dropped before the plan is stored.

## Limits

- The rule-based simulator recognizes a bounded set of phrasings. It demonstrates the pipeline, not language understanding. Real extraction quality depends on the model and is measured only by the opt-in eval (`npm run test:memory:live`), which hasn't been run in this environment (no API key).
- Della knows only what you told it. It can't see files, photos' meaning (unless assessment is on), or the physical world.
