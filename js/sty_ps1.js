import { OMPalette } from './model/palette.js';
import { OMVirtualPalette } from './model/virtualPalette.js';
import { OMTile } from './model/tile.js';
import { OMSprite } from './model/sprite.js';
import { OMFont } from './model/font.js';
import { OMCar } from './model/car.js';
import { paletteBases, spriteBases } from './constants.js';

/*
 * GTA2 PlayStation style file (DATA/BIL.STY, STE.STY, WIL.STY on the PS1 disc).
 *
 * Unlike the PC file there is no "GBST" header and no chunks: it is a run of tables followed by the pixel data,
 * all little-endian. What is known (see PS1_STY_FORMAT.md):
 *
 *   0x00  u16 x6   sprite base counts: car, ped, code_obj, map_obj, user, font        (= PC SPRB)
 *   0x0c  u16      number of car delta pieces
 *   0x0e  u16      unknown
 *   0x10  u16      font count, then u16 per font: number of glyphs                     (= PC FONB)
 *   0x20  u8 x N   one byte per car sprite (N = car sprite count), padded to 4
 *         u16 ...  materials: 9 zero-terminated lists of tile numbers                 (= PC SPEC)
 *         u8 ...   recycled car models, 0xff terminated                               (= PC RECY)
 *         u16 ...  per-tile flags, 0xffff terminated (meaning unknown)
 *         u16 ...  palette number of every sprite, then of every remap (car, ped), 0 terminated
 *         8 bytes  per sprite: u32 addr, u8 width in bytes, u8 height, u8 width in pixels (0 = 2 x bytes), u8 flags
 *                  addr = page << 16 | y << 8 | x byte; flags bit 0 = only the left half is stored (mirrored cars)
 *         8 bytes  per car delta piece, same format
 *         16 bytes car info header: u16 sprite count, u16 car remap count, rest unknown
 *         ...      car info records, as PC CARI
 *         ...      car deltas, 4-aligned, per car sprite: u16 count, u16 first piece, count x (s16 x, s16 y) = the
 *                  piece's centre relative to the car sprite's centre
 *         u32      0x0000ffff, end of the tables
 *         pixels   sprite pages, 256 bytes x 256 rows each, 4 bits per pixel, low nibble = left pixel
 *                  (car sprites are 8 bits per pixel, except the wrecks)
 *         ...      palettes: one 512-byte line per palette number (256 PS1 colours, 5:5:5;
 *                  4bpp sprites use the first 16), ending where the tiles start
 *         tiles    6 blocks of 0x8800 bytes at the end of the file: a 256x256 4bpp page (128 bytes per row)
 *                  of 64 tiles of 32x32, 8 per row, then the 64 tiles' CLUTs (32 bytes each)
 */

const TILE_BLOCKS = 6;          // 384 tiles: the PS1 keeps them all in VRAM (x 320..511, 512 lines)
const TILE_BLOCK_SIZE = 0x8800;
const TILES_PER_BLOCK = 64;
const PAGE_SIZE = 0x10000;
const FONT1_SIG = [[2, 16, 3, 0], [3, 16, 5, 0], [3, 16, 6, 0]];  // '!', '"', '$' of font 1, same in all cities

export class STYPS1 {
    constructor(binaryData) {
        this.isPS1 = true;
        this.tileSize = 32;
        this.spritePageWidth = 512;
        this.bytes = new Uint8Array(binaryData);
        this.view = new DataView(binaryData);
        this.data = {};
        this.error = '';

        try {
            this.locate();
        } catch(e) {
            this.error = e.message;
            console.warn(`Not a PS1 STY: ${e.message}`);
            return;
        }

        this.createObjectModel();
    }

    static looksLikePS1(binaryData) {
        const b = new Uint8Array(binaryData);
        if(b.length < 0xd0000) return false;
        return STYPS1.findPixelBase(b) > 0;
    }

    static findPixelBase(b) {
        for(let k = 0; k < 256; k++) {
            const p = b.length - 0xd0000 - 32*k;
            if(p > 4 && b[p-4] == 0xff && b[p-3] == 0xff && b[p-2] == 0 && b[p-1] == 0) return p;
        }
        return -1;
    }

    isFileCorrect() {
        return !this.error;
    }

    u16(o) { return this.view.getUint16(o, true); }
    u32(o) { return this.view.getUint32(o, true); }

    locate() {
        const b = this.bytes;
        this.pixelBase = STYPS1.findPixelBase(b);
        if(this.pixelBase < 0) throw new Error('no end-of-tables marker');

        this.spriteBases = [];
        for(let i = 0; i < 6; i++) this.spriteBases.push(this.u16(i*2));
        const fontCount = this.u16(0x10);
        this.fontBases = [];
        for(let i = 0; i < fontCount; i++) this.fontBases.push(this.u16(0x12 + i*2));
        this.spriteCount = this.spriteBases.reduce((a, c) => a + c, 0);

        let font1 = -1;
        const match = (o, sig) => sig.every((v, i) => b[o+i] == v);
        for(let o = 0; o < this.pixelBase; o += 4) {
            if(match(o+4, FONT1_SIG[0]) && match(o+12, FONT1_SIG[1]) && match(o+28, FONT1_SIG[2])) { font1 = o; break; }
        }
        if(font1 < 0) throw new Error('sprite index not found');
        const firstFont = this.spriteBases.slice(0, 5).reduce((a, c) => a + c, 0);
        this.spriteTable = font1 - (firstFont + this.fontBases[0]) * 8;

        this.tileBase = b.length - TILE_BLOCKS * TILE_BLOCK_SIZE;
        if(this.tileBase <= this.pixelBase) throw new Error('file too small for the tile blocks');

        // header lists after the car flag bytes
        let o = (0x20 + this.spriteBases[0] + 3) & ~3;
        this.materialLists = [[]];
        while(this.materialLists.length <= 9 && o < this.spriteTable) {
            const v = this.u16(o); o += 2;
            if(v == 0) this.materialLists.push([]);
            else this.materialLists[this.materialLists.length-1].push(v);
        }
        this.materialLists.pop();
        this.recycled = [];
        while(o < this.spriteTable && b[o] != 0xff) this.recycled.push(b[o++]);

        // palette numbers: right after the 0xffff that ends the per-tile flag list, up to a 0 after the sprite entries
        let v = this.spriteTable;
        while(v > 0x20 && this.u16(v - 2) != 0xffff) v -= 2;
        if(v <= 0x20) throw new Error('palette number table not found');
        this.paletteNumbers = [];
        for(let i = 0; v + i*2 < this.spriteTable; i++) {
            const p = this.u16(v + i*2);
            if(i >= this.spriteCount && p == 0) break;
            this.paletteNumbers.push(p);
        }
        if(this.paletteNumbers.length < this.spriteCount) throw new Error('palette number table too short');
        this.paletteCount = Math.max(...this.paletteNumbers) + 1;
        this.paletteBase = this.tileBase - this.paletteCount * 0x200;

        this.spritePagesCount = 0;
        for(let i = 0; i < this.spriteCount; i++)
            this.spritePagesCount = Math.max(this.spritePagesCount, (this.u32(this.spriteTable + i*8) >>> 16) + 1);

        // car delta pieces: 8-byte records right after the sprite index
        this.deltaRecords = this.spriteTable + this.spriteCount*8;
        this.deltaCount = this.u16(0x0c);
        // car info header: u16 sprite count, u16 car remap count (37), ...
        this.carInfoHeader = -1;
        for(let h = (this.deltaRecords + this.deltaCount*8 + 1) & ~1; h + 20 <= this.pixelBase; h += 2) {
            if(this.u16(h) == this.spriteCount && this.u16(h+2) == 37) { this.carInfoHeader = h; break; }
        }
    }

    createObjectModel() {
        const palettes = this.parsePalettes();
        const tiles = this.parseTiles(palettes);
        const spriteIndexes = this.parseSpriteIndexes();
        const sprites = this.parseSprites(spriteIndexes, palettes);
        const fonts = this.parseFonts(sprites);

        const virtualPalettes = {};
        paletteBases.forEach(name => virtualPalettes[name] = []);
        virtualPalettes['tile'] = tiles.map(t => t.bitmap.virtualPalette);
        virtualPalettes['sprite'] = this.spriteVirtualPalettes;
        // remaps follow the sprites in the palette number table: 37 car remaps (as on PC), then the ped remaps
        // (up to the last palette); a second run of the car remap palettes follows, its use is unknown
        const remaps = this.paletteNumbers.slice(this.spriteCount);
        const carRemaps = remaps.slice(0, 37);
        let pedEnd = 37;
        while(pedEnd < remaps.length && remaps[pedEnd] != carRemaps[0]) pedEnd++;
        const toVPal = (base) => (p, i) => new OMVirtualPalette(base, i, palettes[p]);
        virtualPalettes['car_remap'] = carRemaps.map(toVPal('car_remap'));
        virtualPalettes['ped_remap'] = remaps.slice(37, pedEnd).map(toVPal('ped_remap'));

        const cars = this.parseCars(sprites, virtualPalettes);
        const carSprites = this.parseCarDeltas(sprites, spriteIndexes);
        cars.forEach(car => { if(car.sprite) car.sprite = carSprites[car.sprite.relID]; });

        this.data = {
            palettes,
            virtualPalettes,
            tiles,
            sprites,
            spritePagesCount: this.spritePagesCount,
            cars,
            fonts,
        };
    }

    clutToPalette(offset, id, colours = 16) {
        // PS1 colours (5:5:5, bit 15 = semi-transparency) -> the viewer's 256-entry RGBA palette
        const data = new Uint8ClampedArray(256*4);
        for(let i = 0; i < colours; i++) {
            const c = this.u16(offset + i*2);
            data[i*4]   = (c & 31) * 255 / 31;
            data[i*4+1] = ((c >> 5) & 31) * 255 / 31;
            data[i*4+2] = ((c >> 10) & 31) * 255 / 31;
            data[i*4+3] = 255;
        }
        return new OMPalette(~~(id/64), id%64, data);
    }

    // a palette line whose entries past the first 16 are all one filler colour belongs to 4bpp sprites
    paletteIs8bpp(p) {
        const o = this.paletteBase + p*0x200;
        const filler = this.u16(o + 32);
        for(let i = 17; i < 256; i++)
            if(this.u16(o + i*2) != filler) return true;
        return false;
    }

    parsePalettes() {
        // 0..paletteCount-1: the sprite palettes, numbered as in the palette number table
        const palettes = [];
        for(let p = 0; p < this.paletteCount; p++)
            palettes.push(this.clutToPalette(this.paletteBase + p*0x200, p, 256));

        // then the tiles' own CLUTs
        this.tilePaletteStart = palettes.length;
        for(let blk = 0; blk < TILE_BLOCKS; blk++) {
            const clutBase = this.tileBase + blk*TILE_BLOCK_SIZE + 0x8000;
            for(let t = 0; t < TILES_PER_BLOCK; t++)
                palettes.push(this.clutToPalette(clutBase + t*32, palettes.length));
        }
        return palettes;
    }

    parseTiles(palettes) {
        const tiles = [];
        const ts = this.tileSize;
        for(let blk = 0; blk < TILE_BLOCKS; blk++) {
            const base = this.tileBase + blk*TILE_BLOCK_SIZE;
            for(let t = 0; t < TILES_PER_BLOCK; t++) {
                const id = blk*TILES_PER_BLOCK + t;
                const tx = t % 8, ty = ~~(t / 8);
                const px = new Array(ts*ts);
                for(let y = 0; y < ts; y++) {
                    const row = base + (ty*ts + y)*128 + tx*16;
                    for(let x = 0; x < ts; x++)
                        px[y*ts + x] = (this.bytes[row + (x >> 1)] >> ((x & 1) * 4)) & 15;
                }
                const vPal = new OMVirtualPalette('tile', id, palettes[this.tilePaletteStart + id]);
                tiles.push(new OMTile(id, blk, t, px, vPal, null, ts));
            }
        }

        const tileCount = tiles.length;
        this.materialLists.forEach((list, material) => {
            list.forEach(id => { if(id < tileCount) tiles[id].material = material; });
        });
        return tiles;
    }

    // one 8-byte sprite record (sprites and car delta pieces share the format)
    recordIndex(o, bpp, palette) {
        const ptr = this.u32(o);
        const widthBytes = this.bytes[o+4];
        const storedWidth = bpp == 8 ? widthBytes : (this.bytes[o+6] || widthBytes*2);
        const mirrored = (this.bytes[o+7] & 1) != 0 && widthBytes > 1;
        const pageID = ptr >>> 16;
        const y = (ptr >> 8) & 255;
        const x = (ptr & 255) * 2;   // in 4bpp pixels
        return {
            ptr,
            bpp,
            mirrored,
            storedWidth,
            width: mirrored ? storedWidth*2 : storedWidth,
            height: this.bytes[o+5],
            palette,
            loc: [pageID, x, y, pageID*this.spritePageWidth + x],
        };
    }

    parseSpriteIndexes() {
        const indexes = [];
        for(let i = 0; i < this.spriteCount; i++) {
            const palette = this.paletteNumbers[i];
            // car sprites are 8bpp unless their palette has only 16 colours (the wrecks)
            const bpp = (i < this.spriteBases[0] && this.paletteIs8bpp(palette)) ? 8 : 4;
            indexes.push(this.recordIndex(this.spriteTable + i*8, bpp, palette));
        }
        return indexes;
    }

    // true if the car delta table starts at o (4-aligned): it must cover every car sprite and every delta piece
    // and end at the 0x0000ffff that ends the tables
    deltaTableAt(o) {
        o = (o + 3) & ~3;
        let next = 0;
        for(let s = 0; s < this.spriteBases[0]; s++) {
            if(o + 4 > this.pixelBase) return false;
            const count = this.u16(o), first = this.u16(o+2);
            if(first != next) return false;
            next += count;
            o += 4 + count*4;
        }
        return next == this.deltaCount && o == this.pixelBase - 4;
    }

    parseCars(sprites, virtualPalettes) {
        const cars = [];
        this.deltaTable = -1;
        if(this.carInfoHeader < 0) return cars;
        const b = this.bytes;
        const s8 = v => v << 24 >> 24;
        const bits = v => Array.from({length: 8}, (_, i) => ((v >> i) & 1) == 1);
        const carRemaps = virtualPalettes['car_remap'];
        let o = this.carInfoHeader + 16;
        let lastSpriteID = -1;
        while(o + 15 <= this.pixelBase) {
            // the car records (same as PC CARI) end where the delta table starts
            if(lastSpriteID + 1 >= this.spriteBases[0] && this.deltaTableAt(o)) { this.deltaTable = (o + 3) & ~3; break; }
            const remapsCount = b[o+4];
            const doorsCount = b[o+14+remapsCount];
            if(b[o+1] > 1 || remapsCount > carRemaps.length || doorsCount > 8) break;
            const info = {
                model: b[o], sprite: b[o+1], w: b[o+2], h: b[o+3],
                passengers: b[o+5], wreck: b[o+6], rating: b[o+7],
                front_wheel_offset: s8(b[o+8]), rear_wheel_offset: s8(b[o+9]),
                front_window_offset: s8(b[o+10]), rear_window_offset: s8(b[o+11]),
                info_flags: bits(b[o+12]), info_flags_2: bits(b[o+13]),
            };
            if(info.sprite) lastSpriteID++;
            const car = new OMCar(cars.length, info, sprites['car'][lastSpriteID]);
            for(let i = 0; i < remapsCount; i++) car.addRemap(carRemaps[b[o+14+i]]);
            for(let i = 0; i < doorsCount; i++) car.addDoor(s8(b[o+15+remapsCount+i*2]), s8(b[o+16+remapsCount+i*2]));
            cars.push(car);
            o += 15 + remapsCount + doorsCount*2;
        }

        const recycled = new Set(this.recycled);
        cars.forEach(car => car.recycled = recycled.has(car.model));
        return cars;
    }

    // PS1 deltas are small images placed by their centre relative to the car sprite's centre. Each is converted to
    // the PC delta format (runs of opaque pixels, rows 256 apart). Car sprites are cropped tightly and open doors
    // stick out past their sides, so each car sprite with deltas gets a copy padded evenly to fit them all.
    // Returns the car sprites, padded where needed, for the vehicles view.
    parseCarDeltas(sprites, indexes) {
        const carSprites = sprites['car'].slice();
        if(this.deltaTable < 0) return carSprites;
        let o = this.deltaTable;
        for(let s = 0; s < this.spriteBases[0]; s++) {
            const count = this.u16(o), first = this.u16(o+2);
            const sprite = sprites['car'][s];
            const W = sprite.bitmap.width, H = sprite.bitmap.height;

            const pieces = [];
            let padX = 0, padY = 0;
            for(let j = 0; j < count; j++) {
                const dx = this.view.getInt16(o+4+j*4, true), dy = this.view.getInt16(o+6+j*4, true);
                const index = this.recordIndex(this.deltaRecords + (first + j)*8, indexes[s].bpp, indexes[s].palette);
                const left = (W >> 1) + dx - (index.width >> 1);
                const top = (H >> 1) + dy - (index.height >> 1);
                pieces.push({ index, px: this.getSpriteData(index), left, top });
                padX = Math.max(padX, -left, left + index.width - W);
                padY = Math.max(padY, -top, top + index.height - H);
            }
            o += 4 + count*4;
            if(!count) continue;

            // keep the padded sprite narrower than the 256-pixel delta rows
            padX = Math.min(padX, (255 - W) >> 1);
            padY = Math.min(padY, (255 - H) >> 1);
            const PW = W + padX*2, PH = H + padY*2;
            const data = new Array(PW*PH).fill(0);
            for(let y = 0; y < H; y++)
                for(let x = 0; x < W; x++) data[(y + padY)*PW + x + padX] = sprite.bitmap.data[y*W + x];
            const padded = new OMSprite('car', s, { loc: [sprite.pageID, sprite.x, sprite.y, sprite.absX], width: PW, height: PH },
                data, sprite.bitmap.virtualPalette);
            carSprites[s] = padded;

            pieces.forEach(({ index, px, left, top }) => {
                left += padX; top += padY;
                const delta = [];
                let pos = 0;
                for(let r = 0; r < index.height; r++) {
                    const y = top + r;
                    if(y < 0 || y >= PH) continue;
                    let c = 0;
                    while(c < index.width) {
                        const x = left + c;
                        if(x < 0 || x >= PW || !px[r*index.width + c]) { c++; continue; }
                        const run = [];
                        while(c < index.width && left + c < PW && px[r*index.width + c]) run.push(px[r*index.width + c++]);
                        const p = y*256 + x;
                        delta.push({ offset: p - pos, data: new Uint8ClampedArray(run) });
                        pos = p + run.length;
                    }
                }
                padded.addDelta(delta);
            });
        }
        return carSprites;
    }

    getSpriteData(index) {
        const [pageID, x, y] = index.loc;
        const base = this.pixelBase + pageID*PAGE_SIZE + y*256 + (x >> 1);
        const out = new Array(index.width*index.height);
        const sw = index.storedWidth;
        for(let r = 0; r < index.height; r++) {
            const row = base + r*256;
            for(let c = 0; c < sw; c++) {
                const v = index.bpp == 8 ? this.bytes[row + c] : (this.bytes[row + (c >> 1)] >> ((c & 1) * 4)) & 15;
                out[r*index.width + c] = v;
                if(index.mirrored) out[r*index.width + index.width - 1 - c] = v;
            }
        }
        return out;
    }

    parseSprites(indexes, palettes) {
        this.spriteVirtualPalettes = [];
        const sprites = {};
        let abs = 0;
        spriteBases.forEach((baseName, b) => {
            sprites[baseName] = [];
            for(let rel = 0; rel < this.spriteBases[b]; rel++, abs++) {
                const vPal = new OMVirtualPalette('sprite', abs, palettes[indexes[abs].palette]);
                this.spriteVirtualPalettes.push(vPal);
                const index = indexes[abs];
                sprites[baseName].push(new OMSprite(baseName, rel, index, this.getSpriteData(index), vPal));
            }
        });
        return sprites;
    }

    parseFonts(sprites) {
        const fonts = [];
        let sum = 0;
        this.fontBases.forEach((count, i) => {
            fonts.push(new OMFont(i, sprites['font'].slice(sum, sum + count)));
            sum += count;
        });
        return fonts;
    }

    ///////////////////////////

    getSpritesAsArray() {
        return Object.values(this.data.sprites)
            .reduce((acc, val) => acc.concat(val), []);
    }

    getPaletteUsage(palette) {
        const usage = {};
        for(const [baseName, vPals] of Object.entries(this.data.virtualPalettes)) {
            for(let i = 0; i < vPals.length; i++) {
                if(vPals[i].physicalPalette != palette) continue;
                if(!usage[baseName]) usage[baseName] = [];
                usage[baseName].push(i);
            }
        }
        return usage;
    }
}
