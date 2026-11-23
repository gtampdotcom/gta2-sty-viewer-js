# GTA2 PlayStation STY format (work in progress)

Notes from reverse engineering `DATA/BIL.STY`, `STE.STY` and `WIL.STY` on the US disc (SLUS-00789).

The PS1 file has no `GBST` header and no chunks: it is a run of tables, an end marker, then the pixel data. Everything
is little-endian. The three city files share the layout; table lengths differ slightly (e.g. STE's header is 0x128 bytes
shorter than BIL's).

## Tables

| Offset | Type | Contents |
|---|---|---|
| 0x00 | u16 × 6 | sprite base counts: car, ped, code_obj, map_obj, user, font (= PC `SPRB`; 77 474 548 90 180 719) |
| 0x0c | u16 × 2 | number of car delta pieces (868), then 0 |
| 0x10 | u16 + u16 × n | font count, then glyphs per font (= PC `FONB`; 7: 141 144 144 1 1 144 144) |
| 0x20 | u8 × cars | one byte per car sprite (0/1, meaning unknown), padded to 4 |
| … | u16 lists | materials: 9 zero-terminated lists of tile numbers (= PC `SPEC`) |
| … | u8 list | recycled car models, `0xff` terminated (= PC `RECY`, but the PS1 lists differ from the PC's) |
| … | u16 list | per-tile flags (`0x0040`, `0x2040`, `0x8040`…), `0xffff 0x0000` terminated (unknown) |
| … | u16 × n | palette numbers, starting right after the `0xffff`: one per sprite, then per remap, then `0` (below) |
| … | 8 bytes × 2088 | sprite index (below) |
| … | 8 bytes × 868 | car delta pieces, same record format as the sprite index |
| … | 8 bytes | zero |
| … | 16 bytes | car info header: u16 sprite count (2088), u16 car remaps (37), then 27 6 1 7 4 4 (unknown) |
| … | | car info records, byte-identical to PC `CARI` (83 cars in all three cities) |
| … | | car delta positions (below), starting at the next multiple of 4 |
| … | u32 | `0x0000ffff`: end of tables |

### Car deltas

PC deltas are runs of changed pixels; the PS1 stores each delta as a small image instead. The delta position table
has one entry per car sprite (77, including those with no deltas):

```
u16 count     number of deltas (the same counts as PC DELX; the wrecks have 0)
u16 first     index of its first piece in the delta piece records
count × (s16 x, s16 y)   centre of each piece relative to the centre of the car sprite
```

A piece's top-left pixel is `(sprite width / 2 + x − piece width / 2, sprite height / 2 + y − piece height / 2)`,
rounding the halves down. Pieces use the car sprite's palette and bit depth. Car sprites are cropped tightly, so the
open-door pieces stick out past the sprite's sides; the viewer's vehicles page pads each car sprite to fit them.

### Sprite index record

```
u32 addr      page << 16 | y << 8 | x in bytes
u8  width     in bytes (2 pixels per byte)
u8  height
u8  width_px  real width in pixels when odd (fonts); 0 = 2 × width
u8  flags     bit 0: only the left half is stored, mirror it for the right half (cars)
```

Characters a font doesn't have are 1×1 placeholders pointing at the same address.

Car sprites are 8 bits per pixel: the stored half is `width` pixels wide and the sprite `2 × width`. The exceptions are
the wrecks, whose palettes have only 16 colours: they are 4bpp like everything else (half = `2 × width` pixels). A
palette line whose entries 16–255 are all one filler colour is a 16-colour palette. Car 50 has flag 0 and is stored
full width.

### Palette numbers

Entry *i* (for *i* < sprite count) is sprite *i*'s palette. In the US files that is 2088 entries, then 119 remaps:

* 2088–2124: the 37 car remaps (palettes 217–253)
* 2125–2169: the ped remaps (254–297; 274 appears twice)
* 2170–2206: palettes 217–253 again (use unknown)

## Palettes

With `n` = highest palette number + 1 (298 in all three cities), palette *p* is the 512-byte line at
`tile data start − (n − p) × 0x200`: 256 PS1 colours (5:5:5, bit 15 = semi-transparency). 4bpp sprites use the first
16 entries. On screen the game modulates the colours by a brightness value, so screenshots and VRAM dumps match only
up to a per-channel scale.

## Pixel data

Starts right after the end marker. To find it without parsing the tables, look for `ff ff 00 00` at
`len − 0xd0000 − 32k`: exactly one `k` matches in each city file (32, 29 and 32).

* **Sprite pages:** 256 bytes × 256 rows each, 4 bits per pixel, low nibble = left pixel. In VRAM terms each page is a
  128 × 256 halfword rectangle (two 4bpp texture pages side by side). There are 7 full pages plus part of an 8th.
* **After the sprites:** the palettes (above), which end where the tiles start.
* **Tiles:** the last `6 × 0x8800` bytes of the file. Each block is a 256 × 256-pixel page at 4bpp (128 bytes
  per row): 64 tiles of 32×32, 8 per row and 8 rows, followed by the 64 tiles' CLUTs (32 bytes each, tile *n* uses
  CLUT *n*). That gives 384 tiles, and the highest tile number in the SPEC lists is 383. In VRAM they fill
  x = 320–511 on both halves of the screen.

## Fonts

Font 1 (mission text, pager, HUD) uses colour indices 1 dark, 2 medium, 3 light, 5 outline, 0 transparent. Its glyph
images are identical in all three cities.

## Still open

* What the third run of remap entries (2170–2206) is for.
* The per-tile flag list, the per-car-sprite bytes at 0x20 and the last six numbers in the car info header.
* The menu font is not in the STY files; it should be in `FRONTEND.OVL`, which starts with the menu photos as
  8-bit 112-pixel-wide strips.
