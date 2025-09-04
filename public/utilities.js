export function findNextKeyWithWrap(map, startKey, predicate) {
    const entries = [...map];
    const startIndex = entries.findIndex(([key]) => key === startKey);
  
    if (startIndex === -1) return undefined;
  
    const total = entries.length;
  
    // for loop won't execute if total is 1
    // doesn't matter because we should end the game if there's only one player
    // don't start unless there's >= 2 players
    // end ROUND if there's only 1
    for (let i = 1; i < total; i++) {
        const [key, value] = entries[(startIndex + i) % total];
        if (predicate(value, key)) {
            return key;
        }
    }
  
    return undefined; // No match found
}

export function escapeHTML(str) {
  return str.replace(/[&<>"']/g, c=>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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

function releaseCode(code) {
    activeCodes.delete(code); // free up when room ends
}

String.prototype.removeWhitespace = function() {
    return this.replace(/\s+/g, "");
};