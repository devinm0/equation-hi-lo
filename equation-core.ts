// Shared equation evaluator used by BOTH the server (game/equation.ts) and the browser
// (public/index.html). Having one implementation eliminates client/server discrepancies
// (e.g. the √9/6-10 bug where the two evaluators disagreed and a finite equation got
// auto-folded as NaN on the server).
//
// This file is dependency-free on purpose so it compiles trivially for both targets:
//   - tsc  -> dist/equation-core.js   (server)
//   - esbuild equation-core.ts -> public/equation-core.js   (browser)
//
// The two sides differ only in how they READ a card's value (Card.value enum vs DOM
// dataset.value string), so each builds a Token[] with its own adapter and calls
// evaluateTokens here.

export type Op = "+" | "-" | "*" | "/";

export type Token =
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

export function evaluateTokens(tokens: Token[]): number {
    if (tokens.length === 0) {
        throw new Error("Empty expression");
    }

    // Shunting-yard + infix validation
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
            // Unary √ binds tightest: apply any pending √(s) to THIS number immediately,
            // not to a larger sub-expression. Without this, √9/6-10 would (wrongly) become
            // √(9/6-10) -> √(negative) -> NaN instead of (√9)/6-10.
            while (ops[ops.length - 1]?.kind === "sqrt") {
                output.push(ops.pop()!);
            }
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

    // Evaluate postfix
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
}
