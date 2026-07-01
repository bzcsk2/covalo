// Calculator with a bug in divide()

export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error("Division by zero");
  return a / b;
}

export function power(base: number, exp: number): number {
  return Math.pow(base, exp);
}

export function factorial(n: number): number {
  if (n < 0) throw new Error("Negative input");
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}
