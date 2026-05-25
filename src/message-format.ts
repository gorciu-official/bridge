const BRIDGE_QUOTE_HEADER_PATTERN = /^> \*\*[^*\n]+\*\*: ?/;

export function stripLeadingBridgeQuote(content: string): string {
  const lines = content.split('\n');
  let index = 0;

  if (!BRIDGE_QUOTE_HEADER_PATTERN.test(lines[index] || '')) {
    return content;
  }

  while (index < lines.length && lines[index].startsWith('>')) {
    index += 1;
  }

  return lines.slice(index).join('\n').trimStart();
}
