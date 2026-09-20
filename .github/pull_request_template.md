<!-- Adding firmware? Please confirm these; CI checks the rest. -->

**Project:**

- [ ] `app` is my firmware's CMake `project()` name — the value
      `curl http://device/api/v1/system/ping` reports, not the repo name.
- [ ] My releases attach a `-merged.bin` (full flash) and, for updates, a
      `-ota.bin`.
- [ ] I have listed every board this firmware supports, including any that
      share a chip with another board.
- [ ] Anyone flashing this gets working firmware, or I have said in the entry
      where it does not.

**Signing** (a device accepts only firmware signed with the key it was flashed
with):

- [ ] My releases are signed with a stable key, and I understand that changing
      it strands devices already in the field.
- [ ] Or: these builds are unsigned and I have set `"signed": false`, so the
      plugin warns that they accept no updates afterwards.
