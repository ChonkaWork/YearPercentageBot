/** Drops matches nested inside other matches, keeping page order. */
export function outermost(elements: ArrayLike<Element>): Element[] {
  const list = Array.from(elements);
  const set = new Set(list);
  return list.filter((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (set.has(parent)) return false;
    }
    return true;
  });
}

/** document.title without the site suffix; '' when it's only the site name. */
export function titleFromDocument(doc: Document, suffixes: readonly string[], generic: ReadonlySet<string>): string {
  let title = doc.title.replace(/\s+/g, ' ').trim();
  for (const suffix of suffixes) {
    if (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
  }
  return generic.has(title.toLowerCase()) ? '' : title;
}
