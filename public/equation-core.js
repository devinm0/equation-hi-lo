const precedence = {
  "+": 1,
  "-": 1,
  "*": 2,
  "/": 2
};
function isOpToken(tok) {
  return tok?.kind === "op";
}
function evaluateTokens(tokens) {
  if (tokens.length === 0) {
    throw new Error("Empty expression");
  }
  const output = [];
  const ops = [];
  let prev = null;
  for (const tok of tokens) {
    if (tok.kind === "number") {
      if (prev?.kind === "number") {
        throw new Error("Missing operator between numbers");
      }
      output.push(tok);
      while (ops[ops.length - 1]?.kind === "sqrt") {
        output.push(ops.pop());
      }
    } else if (tok.kind === "sqrt") {
      if (prev && prev.kind === "number") {
        throw new Error("\u221A cannot follow a number");
      }
      ops.push(tok);
    } else if (tok.kind === "op") {
      if (!prev || prev.kind !== "number") {
        throw new Error(`Operator '${tok.value}' must follow a number`);
      }
      while (true) {
        const top = ops[ops.length - 1];
        if (!isOpToken(top)) break;
        if (precedence[top.value] < precedence[tok.value]) break;
        output.push(ops.pop());
      }
      ops.push(tok);
    }
    prev = tok;
  }
  if (prev && prev.kind !== "number") {
    throw new Error("Expression cannot end with an operator");
  }
  while (ops.length > 0) {
    output.push(ops.pop());
  }
  const stack = [];
  for (const tok of output) {
    if (tok.kind === "number") {
      stack.push(tok.value);
    } else if (tok.kind === "sqrt") {
      const v = stack.pop();
      if (v === void 0) {
        throw new Error("\u221A missing operand");
      }
      stack.push(Math.sqrt(v));
    } else if (tok.kind === "op") {
      const b = stack.pop();
      const a = stack.pop();
      if (a === void 0 || b === void 0) {
        throw new Error("Operator missing operands");
      }
      switch (tok.value) {
        case "+":
          stack.push(a + b);
          break;
        case "-":
          stack.push(a - b);
          break;
        case "*":
          stack.push(a * b);
          break;
        case "/":
          stack.push(a / b);
          break;
      }
    }
  }
  if (stack.length !== 1) {
    throw new Error("Invalid expression");
  }
  const result = stack.pop();
  if (result === void 0) {
    throw new Error("Invalid expression");
  }
  return result;
}
export {
  evaluateTokens
};
