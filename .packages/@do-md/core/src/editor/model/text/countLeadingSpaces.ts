
export function countLeadingSpaces(str: string) {
    const match = str.match(/^(\s+)/); // match the run of whitespace at the start
    return match ? match[0] : ""; // return the length of the matched whitespace
}
