import { NumberCard, OperatorCard } from '../enums.js';
import { Card } from '../state.js';

function isNumberCard(
    value: NumberCard | OperatorCard
): value is NumberCard {
    return typeof value === "number" && NumberCard[value] !== undefined;
}

type Op = "+" | "-" | "*" | "/";

type Token =
    | { kind: "number"; value: number }
    | { kind: "op"; value: Op }
    | { kind: "sqrt" };

const precedence: Record<Op, number> = {
    "+": 1,
    "-": 1,
    "*": 2,
    "/": 2,
};

function isOpToken(tok: Token | undefined): tok is { kind: "op"; value: Op } {
    return tok?.kind === "op";
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

/*
applyOps tests: one valid and one invalid. and one with divide by zero
*/

// TODO factor this function out to be shared by server and client
export function applyOps(cardElements: Card[]): number {
    const tokens: Token[] = [];

    // 1️⃣ Cards → tokens
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

    if (tokens.length === 0) {
        throw new Error("Empty expression");
    }

    // 2️⃣ Shunting-yard + infix validation
    const output: Token[] = [];
    const ops: Token[] = [];
    let prev: Token | null = null;

    for (const tok of tokens) {

        // 🔢 Number
        if (tok.kind === "number") {
            // number cannot directly follow another number
            if (prev?.kind === "number") {
                throw new Error("Missing operator between numbers");
            }
            output.push(tok);
        }

        // √ Unary operator
        else if (tok.kind === "sqrt") {
            // √ can only appear at start or after another operator
            if (prev && prev.kind === "number") {
                throw new Error("√ cannot follow a number");
            }
            ops.push(tok);
        }

        // ➕ Binary operator
        else if (tok.kind === "op") {
            // binary operators must follow a number
            if (!prev || prev.kind !== "number") {
                throw new Error(`Operator '${tok.value}' must follow a number`);
            }

            while (true) {
                const top = ops[ops.length - 1];
                if (!isOpToken(top)) break;
                if (precedence[top.value] < precedence[tok.value]) break;
                output.push(ops.pop()!);
            }

            ops.push(tok);
        }

        prev = tok;
    }

    // expression cannot end with an operator or √
    if (prev && prev.kind !== "number") {
        throw new Error("Expression cannot end with an operator");
    }

    while (ops.length > 0) {
        output.push(ops.pop()!);
    }

    // 3️⃣ Evaluate postfix
    const stack: number[] = [];

    for (const tok of output) {

        if (tok.kind === "number") {
            stack.push(tok.value);
        }

        else if (tok.kind === "sqrt") {
            const v = stack.pop();
            if (v === undefined) {
                throw new Error("√ missing operand");
            }
            stack.push(Math.sqrt(v));
        }

        else if (tok.kind === "op") {
            const b = stack.pop();
            const a = stack.pop();
            if (a === undefined || b === undefined) {
                throw new Error("Operator missing operands");
            }

            switch (tok.value) {
                case "+": stack.push(a + b); break;
                case "-": stack.push(a - b); break;
                case "*": stack.push(a * b); break;
                case "/": stack.push(a / b); break;
            }
        }
    }

    if (stack.length !== 1) {
        throw new Error("Invalid expression");
    }

    const result = stack.pop();
    if (result === undefined) {
        throw new Error("Invalid expression");
    }
    return result;
} // TODO tests for applyOps - make sure infix expressions do not count. only root can be unary
