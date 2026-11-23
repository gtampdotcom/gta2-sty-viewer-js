import { OMBitmap } from "./bitmap.js";

export class OMTile {
    constructor(id, pageID, relID, data, virtualPalette, material, size = 64) {
        this.id = id;
        this.pageID = pageID;
        this.relID = relID;
        this.bitmap = new OMBitmap(data, size, size, virtualPalette);
        this.material = null;
    }
}