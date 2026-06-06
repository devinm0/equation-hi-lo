import { NumberCard, OperatorCard } from '../enums.js';
import { Card } from '../state.js';
import { Token, Op, evaluateTokens } from '../equation-core.js';

function isNumberCard(
    value: NumberCard | OperatorCard
): value is NumberCard {
    return typeof value === "number" && NumberCard[value] !== undefined;
}

function operatorFromCard(card: OperatorCard): Op | null {
    switch (card) {
        case OperatorCard.ADD: return "+";
        case OperatorCard.SUBTRACT: return "-";
        case OperatorCard.MULTIPLY: return "*";
        case OperatorCard.DIVIDE: return "/";
        default: return null;
    }
}

// Server-side adapter: convert dealt Card objects into tokens, then evaluate with the
// shared core (equation-core.ts) — the SAME evaluator the browser uses.
export function applyOps(cardElements: Card[]): number {
    const tokens: Token[] = [];

    for (const card of cardElements) {
        const val = card.value;
        if (val == null) continue;

        if (isNumberCard(val)) {
            tokens.push({ kind: "number", value: Number(val) });
        }
        else if (val === OperatorCard.ROOT) {
            tokens.push({ kind: "sqrt" });
        }
        else {
            const op = operatorFromCard(val);
            if (!op) throw new Error(`Unhandled card value: ${val}`);
            tokens.push({ kind: "op", value: op });
        }
    }

    return evaluateTokens(tokens);
}
