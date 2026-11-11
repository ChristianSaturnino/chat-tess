/**
 * Modelos costumam escrever fórmulas com \( \) e \[ \], que o Markdown trataria como escapes.
 * Convertemos para a sintaxe de remark-math fora de blocos de código. Cifrão simples não abre
 * fórmula, para que valores como "R$ 10 e R$ 20" continuem texto.
 */
export function normalizeMath(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `\n$$\n${m.trim()}\n$$\n`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => `$$${m.trim()}$$`),
    )
    .join('');
}
