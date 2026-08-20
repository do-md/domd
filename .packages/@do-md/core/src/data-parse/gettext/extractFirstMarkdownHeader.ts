export const extractFirstMarkdownHeader = (text: string) => {
    // Regular expression to match Markdown headers, up to six hash symbols
    const headerRegex = /^((?:#{1,6})\s)/m;
    const match = headerRegex.exec(text);

    // If a header is matched, return it; otherwise return null
    return match ? match[0] : null;
  }