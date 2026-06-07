import type { ExtractedLink } from './extractLinks';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

const ARCGIS_ITEM_RE =
  /(?:https?:\/\/)?(?:www\.)?arcgis\.com\/home\/item\.html\?id=([a-f0-9]+)/i;

const ARCGIS_DOWNLOAD_TYPES = new Set([
  'Shapefile',
  'File Geodatabase',
  'CSV',
  'KML',
  'GeoPackage',
  'Feature Collection',
  'Image',
  'Map Document',
]);

export async function resolvePortalLinks(pageUrl: string): Promise<ExtractedLink[]> {
  const arcgisMatch = pageUrl.match(ARCGIS_ITEM_RE);
  if (!arcgisMatch) return [];

  const itemId = arcgisMatch[1];
  const links: ExtractedLink[] = [];

  try {
    const res = await fetch(
      `https://www.arcgis.com/sharing/rest/content/items/${itemId}?f=json`,
      {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) return links;

    const data = (await res.json()) as {
      title?: string;
      type?: string;
      url?: string;
      description?: string;
    };

    if (data.title) {
      links.push({ label: `ArcGIS item: ${data.title}`, url: pageUrl });
    }

    if (data.type) {
      links.push({
        label: `ArcGIS type: ${data.type}`,
        url: pageUrl,
      });
    }

    if (data.url) {
      links.push({ label: 'ArcGIS service URL', url: data.url });
    }

    if (data.type && ARCGIS_DOWNLOAD_TYPES.has(data.type)) {
      links.push({
        label: `${data.type} download (ArcGIS REST)`,
        url: `https://www.arcgis.com/sharing/rest/content/items/${itemId}/data`,
      });
    }

    links.push({
      label: 'ArcGIS item metadata (JSON)',
      url: `https://www.arcgis.com/sharing/rest/content/items/${itemId}?f=json`,
    });
  } catch (err) {
    console.log(`ArcGIS portal resolve failed for ${pageUrl}:`, err);
  }

  return links;
}
