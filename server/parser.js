import { decode } from "html-entities";

export function parseDirectory(html, baseUrl) {
  const items = [];

  // IIS directory listings use:
  // date time &lt;dir&gt; <A HREF="...">Folder</A>
  // date time size    <A HREF="...">File</A>

  const rowRegex =
    /(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s+[AP]M)\s+(&lt;dir&gt;|\d+)\s+<A\s+HREF="([^"]+)">([^<]+)<\/A>/gi;

  let match;

  while ((match = rowRegex.exec(html)) !== null) {
    const [, date, time, sizeOrDir, href, rawName] = match;

    const isDirectory =
      sizeOrDir.toLowerCase() === "&lt;dir&gt;";

    const name = decode(rawName.trim());

    const decodedHref = decode(href);
    const url = new URL(decodedHref, baseUrl).href;

    items.push({
      name,
      type: isDirectory ? "folder" : "file",
      date: `${date} ${time}`,
      size: isDirectory ? null : Number(sizeOrDir),
      url,
    });
  }

  return items;
}