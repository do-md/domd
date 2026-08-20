export function getDetailsTag(text: string) {
  // Regular expression to match the structure of <details> tag
  const detailsRegex =
    /<details\s*(open)?\s*>(\s*<summary>(.*?)<\/summary>\s*)([\s\S]*?)<\/details>/g;

  // Find matching content
  const matches = detailsRegex.exec(text);

  // If no match found, return null
  if (!matches) {
    return null;
  }

  // Extract relevant information
  const isOpen = matches[1] ? true : false; // Whether it's in open state
  const titleText = matches[3]; // Title text
  const contentText = matches[4]; // Collapsed content text
  const start = matches.index; // Start position of the collapsed area text
  const end = matches.index + matches[0].length; // End position of the collapsed area text

  // Return extracted information
  return {
    start,
    end,
    isOpen,
    titleText,
    contentText,
  };
}
