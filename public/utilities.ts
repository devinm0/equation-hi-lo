import { Player } from './classes.js';

export function findNextKeyWithWrap<T>(map: [string, T][], startKey: string, predicate: (value: T, key: string) => boolean): string {
    const entries = [...map];
    if (!entries) throw new Error;
    const startIndex = entries.findIndex(([key]) => key === startKey);
  
    if (startIndex === -1) throw new Error ("no player found");
  
    const total = entries.length;
  
    // for loop won't execute if total is 1
    // doesn't matter because we should end the game if there's only one player
    // don't start unless there's >= 2 players
    // end ROUND if there's only 1
    for (let i = 1; i < total; i++) {
        const entry = entries[(startIndex + i) % total];

        if (!entry) continue; // guard against undefined
        const [key, value] = entry;
        if (predicate(value, key)) {
            return key;
        }
    }
  
    throw new Error ("no player found");
}

export function escapeHTML(str: string): string {
  return str.replace(/[&<>"']/g, c=>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
}

const activeCodes = new Set();
const SAFE_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";

function generateRoomCode(length = 4) {
    const bytes = new Uint8Array(length);
    (globalThis.crypto || require("node:crypto").webcrypto).getRandomValues(bytes);

    return Array.from(bytes, (b) => SAFE_ALPHABET[b % SAFE_ALPHABET.length]).join("");
}

export function mintUniqueCode(length = 4) {
    let code;
    do {
        code = generateRoomCode(length);
    } while (activeCodes.has(code)); // collision check
    activeCodes.add(code);
    return code;
}

function releaseCode(code: string) {
    activeCodes.delete(code); // free up when room ends
}

export function removeWhitespace(s: string) {
    return s.replace(/\s+/g, "");
};