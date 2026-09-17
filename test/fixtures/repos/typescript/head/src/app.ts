export function add(a: number, b: number): number {
  if (typeof a !== 'number') throw new TypeError('a must be a number');
  return a + b;
}
