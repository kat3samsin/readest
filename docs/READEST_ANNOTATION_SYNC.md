# Readest annotation sync contract

Status: design only. The current firmware must continue to advertise
`readestSync.highlights: false` until the final capability gate in this
document is met.

This contract extends the existing Readest book and progress bridge. It is
intentionally staged: point bookmarks are feasible with the current reader,
but range highlights are not. CrossPoint does not yet retain word-level source
positions, render annotation overlays, or provide text selection.

## Goals

- Round-trip point bookmarks without losing concurrent edits or deletions.
- Preserve Readest range annotations before CrossPoint can display them.
- Keep annotation positions stable across font-size and layout changes.
- Bound memory use on the X4 and replace every sidecar atomically.
- Advertise only behavior that is implemented and verified on hardware.

## Non-goals for the first implementation

- Treating a range highlight as a page bookmark.
- Using page number or percentage as a range anchor.
- Editing Readest's native CFI directly in firmware.
- Garbage-collecting tombstones.
- Supporting concurrent syncs from multiple Readest clients to one device.
- Setting `highlights: true` for storage-only or display-only support.

Version 1 assumes one logical Readest bridge syncs with a CrossPoint at a
time. Readest Cloud can still synchronize the account's apps before and after
the device sync. Supporting simultaneous bridge writers requires per-replica
sidecars or conditional WebDAV writes and is a later protocol change.

## Identity and positions

`document` is the lowercase 32-character Readest `partialMD5` already used by
the library manifest and progress protocol. It is a sampled digest, not proof
of identical EPUB bytes. A snapshot is accepted only for an active manifest
entry whose byte size matches the header and the current root EPUB. This keeps
the existing bridge identity but retains a small sampled-hash collision risk.
Metadata hashes and titles are not substitutes because anchors are
edition-specific. Range display requires a later schema with a verified full
content digest.

Every annotation is keyed by `(document, id)`. Readest IDs are preserved
exactly. A legacy or newly created CrossPoint bookmark receives:

```text
md5("crosspoint-annotation-v1\0" + document + "\0bookmark\0" + xpointer0)
```

Position fields use CREngine XPointer strings:

- `xpointer0` is the point or range start and is required for a live record.
- `xpointer1` is required for `annotation` and `excerpt` records and absent for
  a point `bookmark`.
- `percentage` and `page` are optional hints. They are never identity or merge
  keys.
- CFI is not transported. Readest resolves CFI to XPointer before export and
  converts XPointer back to CFI against the matching EPUB when applying an
  import.

CrossPoint must not import a range as a point when it cannot resolve the end.
It preserves the range record without adding it to the native bookmark UI.

## Files and ownership

Each document has two deterministic newline-delimited JSON snapshots:

```text
/.crosspoint/readest-sync/<document>.annotations.readest.ndjson
/.crosspoint/readest-sync/<document>.annotations.crosspoint.ndjson
```

- Readest may `GET`/`HEAD` both files and `PUT` only the Readest-owned file.
- CrossPoint reads both files and writes only the CrossPoint-owned file.
- WebDAV `DELETE`, `MOVE`, `COPY`, and `MKCOL` remain forbidden for both.
- Deletion is represented by a record tombstone, never by deleting a sidecar.
- Before the first commit, a failed upload, validation, merge, or preflight
  leaves both previous snapshots intact. A power loss after the Readest commit
  may leave a valid new Readest snapshot beside the prior CrossPoint snapshot;
  recovery treats that as a partial commit and reruns the merge.

Separate writers prevent a Readest update and a CrossPoint update from
blindly overwriting the same file. Each owner writes the complete merged state
it knows, not only its locally created records.

### NDJSON framing

The file is UTF-8 without a byte-order mark. Every line is one JSON object,
terminated by `\n`; blank lines are invalid. The first line is the header:

```json
{"record":"header","schemaVersion":1,"document":"0123456789abcdef0123456789abcdef","byteSize":3381248,"owner":"readest"}
```

`owner` must match the filename. Remaining lines are annotation records sorted
by the UTF-8 byte order of `id`, with exactly one record per ID.

A live bookmark can contain:

```json
{"record":"annotation","id":"4ca92ce","revision":"0019a5f2c1000-00000000-readest-a1","deleted":false,"type":"bookmark","xpointer0":"/body/DocFragment[1]/body/p[12].0","percentage":0.26,"summary":"Opening words on the page","note":"","createdAt":1784060000000}
```

A live range can contain:

```json
{"record":"annotation","id":"77ad218","revision":"0019a5f2c1001-00000000-readest-a1","deleted":false,"type":"annotation","xpointer0":"/body/DocFragment[1]/body/p[12].4","xpointer1":"/body/DocFragment[1]/body/p[12].28","text":"selected text","note":"my note","style":"highlight","color":"yellow","page":12,"global":false,"createdAt":1784060000100}
```

A tombstone contains only the state needed to suppress older versions:

```json
{"record":"annotation","id":"77ad218","revision":"0019a5f2c1002-00000000-crosspoint-a1","deleted":true}
```

The schema-1 key whitelist is normative:

| Record form | Required keys | Allowed optional keys |
| --- | --- | --- |
| header | `record`, `schemaVersion`, `document`, `byteSize`, `owner` | none |
| tombstone | `record`, `id`, `revision`, `deleted: true` | none |
| live bookmark | tombstone keys with `deleted: false`, plus `type: bookmark`, `xpointer0` | `percentage`, `summary`, `note`, `page`, `createdAt` |
| live annotation or excerpt | tombstone keys with `deleted: false`, plus `type`, `xpointer0`, `xpointer1` | `percentage`, `text`, `note`, `style`, `color`, `page`, `global`, `createdAt` |

`excerpt` is notebook content, not a rendered highlight. CrossPoint preserves
it but never draws it as an overlay. `summary` is bookmark-only; `global` is
annotation-only. JSON `null` is not a substitute for an absent optional key.

### Version 1 validation limits

Validation is strict and happens before replacement:

- header: at most 512 UTF-8 bytes;
- annotation line: at most 8 KiB;
- snapshot: at most 512 KiB and 1,024 annotation records;
- `byteSize`: a positive safe integer equal to the active manifest entry and
  current EPUB size;
- `id`: 1-128 UTF-8 bytes, with no control characters;
- each XPointer: 1-1,024 UTF-8 bytes;
- `summary`, `text`, and `note`: at most 2,048 UTF-8 bytes each;
- `style`: `highlight`, `underline`, or `squiggly` when present;
- `color`: at most 128 UTF-8 bytes;
- `percentage`: finite and in `[0, 1]` when present;
- `page` and `createdAt`: non-negative safe integers when present;
- `global`: Boolean when present.

Every object rejects duplicate JSON keys and same-schema keys outside the
whitelist. `revision` must match
`^[0-9a-f]{13}-[0-9a-f]{8}-[a-z0-9][a-z0-9._-]{0,63}$`.

The serializer checks the final encoded line and file sizes, including JSON
escaping. It never truncates a field. The merged output must also fit the same
512 KiB and 1,024-record limits, even when both inputs fit separately. A
streaming preflight writes and validates a merged temporary file before any
snapshot or native bookmark state changes. Capacity exhaustion fails visibly
without truncation or replacement.

Schema 1 recognizes only `bookmark`, `annotation`, and `excerpt`. Unknown keys,
unknown types, or a higher schema version must not be silently discarded. An
older endpoint leaves the files untouched, reports an unsupported-schema
failure, and does not publish a reduced snapshot. Adding a semantic field
requires a schema revision.

Firmware validation and merge are streaming operations. Because both inputs
are sorted, peak heap use must be bounded by one header, one record from each
input, and fixed parser/output state. The implementation must not build a
collection-sized map or `JsonDocument`.

## Revision and merge rules

Each record has one hybrid logical clock (HLC) `revision`:

```text
<physical-ms:13 lowercase hex>-<counter:8 lowercase hex>-<actor>
```

`actor` is 1-64 lowercase ASCII characters from `[a-z0-9._-]` and begins with
an alphanumeric character. Readest uses `readest-<stable UUID>`. CrossPoint
generates and atomically persists `crosspoint-<random 128-bit lowercase hex>`;
it never relies on the optional serial. The complete HLC is compared
lexicographically.

Every document has one mutation lock. Before minting a revision, a writer must
load both current valid snapshots, observe their maximum revision, and advance
from the greater of that value and its persisted generator state. Readest must
`GET` and observe both files before export. CrossPoint must observe and persist
the maximum revision from an accepted WebDAV upload before acknowledging it or
allowing a bookmark mutation. It persists a newly minted generator state
before committing the event, so a crash can skip a value but cannot reuse it.
A real-time clock is not required.

`nextAfter` increments the counter at the maximum observed physical field. A
counter overflow increments the physical field and resets the counter. At the
absolute maximum physical field and counter, mutation fails visibly rather
than wrapping.

The merge is a whole-record last-writer-wins set:

1. Validate both sorted inputs, then merge-join them by `id` while holding only
   the current record from each input.
2. For the same ID, choose the record with the lexicographically greater
   `revision`.
3. If revisions and normalized parsed records are identical, keep either copy.
   Key order, insignificant number spelling, and JSON escaping do not affect
   equality.
4. If revisions match but normalized records differ, report a protocol
   conflict and write neither snapshot. This indicates a broken actor or
   generator invariant.
5. Emit the sorted stream to a bounded temporary snapshot and atomically
   replace only the local owner's snapshot.

Within the published output limits, this operation is commutative,
associative, and idempotent. Deletion is a newer record with `deleted: true`;
a still newer live record is an explicit resurrection. Tombstones are retained
indefinitely in version 1. Safe garbage collection requires acknowledgements
from every possible replica and is not implied by a successful two-file sync.

For a Readest `PUT`, a missing old sidecar means empty state; a malformed one
never does. Firmware validates the upload and builds a bounded merged
CrossPoint temporary snapshot before committing. It commits the Readest file
first, then the CrossPoint snapshot, persists the observed HLC state, and only
then returns success. If power fails between commits, recovery keeps the valid
Readest file and reruns the merge. A local bookmark mutation follows the same
document lock and preflight before changing the native bookmark view.

Readest keeps durable per-ID bridge state separately from
`BookNote.updatedAt` and `deletedAt`: winning wire revision, semantic
fingerprint, pending payload, last-applied native fingerprint, and the native
update/delete clocks observed at apply time. Its existing timestamp merge is
not the wire conflict rule.

A winning tombstone applies immediately by ID without CFI resolution. Readest
records a native deletion clock strictly newer than the note's current native
clocks and persists the bridge row before normal cloud sync. A live record that
cannot yet be converted to CFI remains durable pending state until the matching
EPUB opens. After apply, an unchanged native fingerprint is not re-exported as
a fresh edit; a new HLC is minted only for a later semantic native change. If a
stale cloud live note reappears, the still-winning bridge tombstone is
reasserted instead of being treated as a resurrection.

The bridge stores an apply watermark equal to the maximum native `updatedAt`
and `deletedAt` observed after apply. Any native semantic transition, including
a live edit, deletion, or resurrection, mints a wire HLC only when its relevant
native maximum clock is strictly greater than that watermark. An equal or older
clock reasserts the current wire winner. This suppresses stale cloud live
records, edits, and tombstones symmetrically.

When a live wire record lacks native-required values, Readest synthesizes
`note: ""`, sets `createdAt` once when first applied, and gives `updatedAt` a
fresh native clock. These synthesized native-only values and the derived CFI
are recorded in bridge state but excluded from the wire semantic fingerprint.
They cannot trigger a fresh export unless the user later changes their
semantics.

## Capability contract

Annotation support is an additive protocol-2 field so older Readest clients
can continue syncing books and progress:

```json
{
  "readestSync": {
    "protocol": 2,
    "books": true,
    "progress": true,
    "highlights": false,
    "annotations": {
      "schemaVersion": 1,
      "bookmarks": "read-write",
      "rangeHighlights": "none"
    }
  }
}
```

`annotations` is absent until stage 1 works. `rangeHighlights` has four values:

- `none`: range records are not accepted;
- `preserve`: records round-trip without display or editing;
- `display`: every imported annotation range, including multi-page and
  `global: true` occurrences, renders, but the device cannot edit it;
- `read-write`: those ranges can also be created, edited, and deleted on the
  device. Excerpts remain notebook-only.

The top-level `highlights` Boolean remains `false` for `none`, `preserve`, and
`display`. It becomes `true` only with `rangeHighlights: "read-write"`, a
Readest runner that actually performs annotation sync, and completed hardware
acceptance tests. The Readest UI must describe intermediate modes as stored
only or view only, never as fully supported.

## Delivery stages

### Stage 1: point bookmarks

Firmware:

- Add a streaming protocol and merge library under `lib/ReadestAnnotations/`.
- Route both bookmark toggle and bookmark-list deletion through one atomic
  store; add stable ID/revision metadata while preserving old bookmark files.
- Generate tombstones before removing a native bookmark.
- Extend `WebDAVPathPolicy` and `WebDAVHandler` with the ownership, validation,
  atomic replacement, and recovery rules above.
- Import Readest bookmarks on book open and update the CrossPoint snapshot
  after every local mutation.

Readest:

- Add `annotationProtocol.ts` and property tests for validation and merge.
- Add `annotationResolver.ts`, opening an EPUB once per book to resolve all
  exported CFIs to XPointers.
- Add bridge state, planner, and sync modules beside the progress bridge.
- Apply CrossPoint tombstones immediately by ID. Keep unresolved live records
  durable, then convert XPointer to CFI and merge them into the latest in-memory
  BookNotes when the matching EPUB opens.
- Report per-book annotation failures without undoing successful book or
  progress sync.

Stage 1 advertises `bookmarks: "read-write"`,
`rangeHighlights: "none"`, and `highlights: false`.

### Stage 2: lossless range transport

CrossPoint parses, merges, and re-emits every schema-1 range field without
showing it in the bookmark UI. Unsupported, oversized, or over-capacity unions
fail the book without modifying either valid snapshot or native state. Stage 2 advertises
`rangeHighlights: "preserve"` and keeps `highlights: false`.

### Stage 3: display imported ranges

- Define schema-2 negotiation and migration before implementation. Both sides
  must first read v1 and v2 while writing v1. Readest may upgrade its owner
  snapshot only after firmware advertises v2 read support; firmware then merges
  the mixed pair and upgrades its own snapshot. No endpoint down-converts a v2
  file, and books/progress continue if an older client refuses annotations.
- Retain stable flattened source offsets while parsing XHTML.
- Add compact word/source coordinates to rendered blocks and bump the section
  cache version.
- Resolve both XPointer endpoints to source intervals.
- Introduce an annotation schema carrying a verified full EPUB content digest.
- Render multi-page ranges and every occurrence of `global: true` annotations.
- Draw overlays at render time, not into the cached page bitmap, so font and
  layout changes do not require annotation-specific repagination.

The capability stays `rangeHighlights: "preserve"` until both owner snapshots
have upgraded without dropping records and the display gates pass. Stage 3 then
advertises `rangeHighlights: "display"` and keeps `highlights: false`.

### Stage 4: create and delete ranges on CrossPoint

- Add a button-driven selection activity. Implementation may begin with
  same-page words, but capability stays `display` until multi-page creation and
  editing work.
- Create stable IDs and revisions through the same annotation store.
- Support edit/delete tombstones from both the reader and annotation list.
- Round-trip style, color, note, text, and `global` without silent reduction.

Only stage 4 may advertise `rangeHighlights: "read-write"` and
`highlights: true`.

## Verification gates

Protocol tests on both sides must cover:

- malformed, duplicate, wrong-document, wrong-owner, oversized, and newer
  schema inputs;
- atomic upload failure and boot-time recovery preserving the previous file;
- canonical serialization and stable legacy bookmark IDs;
- merge commutativity, associativity, idempotence, edit/delete races,
  resurrection, and equal-HLC conflict handling;
- remote PUT versus local-mutation serialization, actor collision, HLC
  rollover, and maximum disjoint snapshots;
- a maximum-size snapshot without collection-sized allocation;
- exact preservation of every schema-1 range field through CrossPoint.

Integration tests must cover Readest-to-CrossPoint and CrossPoint-to-Readest
create/delete flows, offline concurrent changes, power loss during each commit,
closed-book tombstones, unresolved XPointer retention, apply/re-export
idempotence, stale-cloud edit/deletion/resurrection suppression, and staged
XPointer-to-CFI application when the EPUB opens.

Before `highlights: true`, the same X4 must also verify that a range stays on
the same words after font-size changes, margin changes, page turns, reopen,
and reboot; that global and multi-page ranges work; that create/delete
round-trips in both directions; and that a
20-sample page-turn benchmark with annotations does not regress the current
fast firmware median by more than 5%. Free heap must remain stable across a
maximum-size streamed sync.

## Expected implementation touchpoints

Firmware:

- `src/BookmarkEntry.h`
- `src/JsonSettingsIO.cpp`
- `src/activities/reader/EpubReaderActivity.cpp`
- `src/activities/reader/EpubReaderBookmarksActivity.cpp`
- `src/network/WebDAVPathPolicy.*`
- `src/network/WebDAVHandler.*`
- `src/network/CrossPointWebServer.cpp`
- `lib/ReadestAnnotations/`
- later: EPUB parser, `TextBlock`, `ProgressMapper`, reader menu, and a
  selection activity

Readest:

- `apps/readest-app/src/services/sync/devices/crosspoint/annotationProtocol.ts`
- `annotationResolver.ts`, `annotationState.ts`, `annotationPlanner.ts`, and
  `annotationSync.ts`
- `liveAnnotations.ts`
- `runBookSync.ts` and `client.ts`
- `CrossPointForm.tsx`
- `useCrossPointPendingAnnotations.ts` and `FoliateViewer.tsx`
