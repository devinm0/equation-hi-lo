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