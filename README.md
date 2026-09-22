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

1. Fork this repository.
2. Add `projects/<your-id>.json`. Copy an existing entry; the fields are
   described in [`schema/project.schema.json`](schema/project.schema.json).
3. Open a pull request titled `add: <your-id>`.

CI checks that the entry is well-formed and that your repository and release
assets are real. A maintainer reviews new entries; after that you own your own
file and can update it yourself.

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

### Signing

A device accepts only firmware signed with the key it was flashed with. So:

- moving a device from one project to another needs a USB cable, not an
  over-the-air update;
- a release built with a throwaway key (`signed: false`) will flash but accept
  no updates afterwards, and the plugin says so;
- changing your signing key strands every device already in the field. Record
  it as `signingKeyId` so that change is visible rather than silent.

## What a valid entry does and does not mean

Firmware cannot be load-tested in CI the way an npm package can — that needs
the board. So validation proves an entry is well-formed, its repository exists
and its release assets are downloadable. It does not prove the firmware works.

`official` marks projects maintained by the signalk-espOS organisation.
Everything else is community-contributed, and the plugin labels it that way.

## Licence

The registry data is Apache-2.0. Each listed project carries its own licence.
