# espOS firmware registry

The list of firmware projects that [espOS](https://github.com/signalk-espOS/espOS)
devices can run. The
[signalk-espos-manager](https://github.com/signalk-espOS/signalk-espos-manager)
plugin reads it to work out what a boat's devices could be updated to.

Each project is one file under [`projects/`](projects). CI resolves their
GitHub releases into [`index.json`](index.json), which is what the plugin
fetches — a single unauthenticated request, so a boat needs no token and hits
no rate limit.

## Adding your firmware

1. Publish your firmware as GitHub releases. espOS's reusable
   [`release-firmware.yml`](https://github.com/signalk-espOS/espOS/blob/main/docs/releasing.md#releasing-a-firmware)
   builds, attaches and mirrors them in the shape this registry reads.
2. Fork this repository and add **one file**, `projects/<your-id>.json`. Copy an
   existing entry; the fields are described in
   [`schema/project.schema.json`](schema/project.schema.json). Leave
   `index.json` alone: it is rebuilt after your pull request merges.
3. Open a pull request titled `add: <your-id>`.

CI checks the entry and shows what it resolves to -- how many releases and
builds, and how many a browser can flash. A maintainer reviews new entries.
Once merged, the index is rebuilt within minutes and your firmware appears in
the Signal K plugin and the hosted flasher.

To see the same result before opening the pull request (Node 24, and a token,
because GitHub allows 60 unauthenticated requests an hour):

```sh
export GH_TOKEN=$(gh auth token)   # or GITHUB_TOKEN
node scripts/validate.mjs
node scripts/reindex.mjs           # rewrites index.json locally; do not commit it
```

### The field people get wrong

`app` must be your firmware's **CMake `project()` name** — what the device
reports from `/api/v1/system/ping` and announces over mDNS. It is not the
repository name, and not `espos_start_opts_t.app_name`.

espOS matches an update manifest on that string, so getting it wrong means
devices never find their updates and nothing says why. Check it against a
running device:

```sh
curl http://your-device.local/api/v1/system/ping
# {"app":"cockpit","version":"1.2.0","auth":false}
```

### Publishing releases the registry can read

Attach two files per target to each GitHub release:

- `<name>-<target>-v<version>-merged.bin` — the full-flash image, for a board
  being set up for the first time;
- `<name>-<target>-v<version>-ota.bin` — the application image, for updates.

If your names carry no target segment, declare anchored `assets` patterns in
your entry and list exactly one target, so the mapping stays unambiguous. A
build whose target cannot be established is skipped rather than guessed: the
wrong image is one a device rejects only after the whole download.

### Boards

List every board your firmware supports. A board is what someone recognises on
a shop page, and it is what the flasher asks about first: "which board do you
have?", then what can run on it. Several projects can offer the same board —
that is the point, and nothing needs coordinating between them.

**Two boards on one chip needs one extra step.** espOS matches an update on
chip alone, so if you ship a separate image per board, the registry is the only
place that can tell them apart. That takes two halves, and **both** are
required:

1. a `board` named group in your `assets` patterns, and
2. an `assetSegment` on each of those boards, matching what the group captures.

The cockpit does this for its two P4 panels:

```jsonc
"assets": {
  "merged": "^p4_cockpit-v?(?<version>[0-9][^-]*)(?:-(?<board>[a-z0-9]+))?-merged\\.bin$"
},
"boards": [
  { "id": "waveshare-p4-touch-7b",  "target": "esp32p4", "assetSegment": "7b" },
  { "id": "waveshare-p4-touch-x-7", "target": "esp32p4", "assetSegment": "x7" }
]
```

so `p4_cockpit-v1.3.2-7b-merged.bin` resolves to the 7B and nothing else.

With either half missing, no image can be tied to a board, and **every** image
for that chip is withheld rather than offered as a coin toss — on a display
panel the wrong one is usually a black screen, which reads as a hardware fault
rather than a wrong download. CI rejects that shape and tells you which half is
missing, so you find out on the pull request instead of after publishing.

If each of your boards is the only board for its chip, you need none of this: a
target segment in the filename is enough, and you can point `assetSegment` at
the target itself (the BLE gateway does exactly that).

### Which espOS a build was made with

Generated, not declared: the reindexer reads your espOS submodule pin at each
release tag and records the version that release was built against, as `espos`
on the release, alongside `esposLatest` at the top of the index. A consumer can
then say "this firmware is a runtime release behind" — which a web flasher
talking to a blank board has no other way to know, since an unflashed board
cannot be asked.

Nothing is required of you if your submodule lives at `espos`. If it lives
elsewhere, set `esposSubmodule` to its path.

The match is exact: a release pinned to an untagged espOS commit records no
version rather than the nearest tag, because naming a version the build was not
made from is worse than saying nothing.

### Signing

A device accepts only firmware signed with the key it was flashed with. So:

- moving a device to firmware signed with another key needs a USB cable, not an
  over-the-air update;
- a release built with a throwaway key (`signed: false`) will flash but accept
  no updates afterwards. Every build of it is indexed with `"unsigned": true`,
  and the plugin says so;
- changing your signing key strands every device already in the field. Record
  it as `signingKeyId` so that change is visible rather than silent.

`signingKeyId` is the first 16 hex characters of the key's Secure Boot V2
public-key digest, in lower case with no spaces. A device on an espOS release
after 0.15.0 reports the same value as `running.key_fp` in
`GET /api/v1/ota/status` (espOS's default signed-update setting; an original
ESP32 needs chip revision 3), so the plugin can see that an update would be
refused before sending it. Read it from any of your released images, or from
the key itself:

```sh
# the first 8 bytes of "Public key digest for block 0: b3 38 1b 48 b9 cc 99 41 …"
espsecure signature-info-v2 my-firmware-esp32c6-v1.0.0-ota.bin \
  | grep -m1 'Public key digest' | cut -d: -f2 | tr -d ' ' | cut -c1-16
# or from the key file
espsecure digest-sbv2-public-key --keyfile signing_key.pem -o digest.bin
od -An -tx1 digest.bin | tr -d ' \n' | cut -c1-16
```

The id covers every release of the project, so it records the key you sign
with now. After a key change, devices still on the old key are shown as
needing USB even for older releases signed with it.

Each build also carries `otaSha256` and `mergedSha256`, taken from the digest
GitHub records for the asset. The plugin checks the mirrored OTA image
against `otaSha256` and copies it into the manifest, where espOS shows it but
does not verify it: the image's signature is what the device trusts.

## What a valid entry does and does not mean

Firmware cannot be load-tested in CI the way an npm package can — that needs
the board. So validation proves an entry is well-formed, its repository exists
and its release assets are downloadable. It does not prove the firmware works.

`official` marks projects maintained by the signalk-espOS organisation.
Everything else is community-contributed, and the plugin labels it that way.

## Licence

The registry data is Apache-2.0. Each listed project carries its own licence.
