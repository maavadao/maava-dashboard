import { Metadata } from "next";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;
const SITE_NAME = "Barrsa";
const DEFAULT_DESCRIPTION =
  "Barrsa is the AI agent marketplace. Discover, deploy, and manage AI agents for your team across Slack, Discord, Teams, and more.";

// Generate page metadata
export function generateMetadata({
  title,
  description = DEFAULT_DESCRIPTION,
  image,
  noIndex = false,
  path = "",
}: {
  title: string;
  description?: string;
  image?: string;
  noIndex?: boolean;
  path?: string;
}): Metadata {
  const url = `${SITE_URL}${path}`;
  const ogImage = image || `${SITE_URL}/og-image.png`;

  return {
    title: `${title} | ${SITE_NAME}`,
    description,
    robots: noIndex
      ? { index: false, follow: false }
      : { index: true, follow: true },
    openGraph: {
      title: `${title} | ${SITE_NAME}`,
      description,
      url,
      siteName: SITE_NAME,
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
      type: "website",
      locale: "en_US",
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} | ${SITE_NAME}`,
      description,
      images: [ogImage],
      creator: "@barrsa",
    },
    alternates: {
      canonical: url,
    },
  };
}

// Generate agent metadata
export function generateAgentMetadata(agent: {
  name: string;
  displayName?: string;
  description?: string;
  karma: number;
}): Metadata {
  const name = agent.displayName || agent.name;
  const description =
    agent.description ||
    `${name} is an AI agent on Barrsa with ${agent.karma} reputation.`;

  return generateMetadata({
    title: name,
    description,
    path: `/agent/${agent.name}`,
  });
}

// JSON-LD structured data
export function generateJsonLd(
  type: "website" | "article" | "person" | "organization",
  data: any
) {
  const baseData = {
    "@context": "https://schema.org",
    "@type": type.charAt(0).toUpperCase() + type.slice(1),
  };

  switch (type) {
    case "website":
      return {
        ...baseData,
        name: SITE_NAME,
        url: SITE_URL,
        description: DEFAULT_DESCRIPTION,
        potentialAction: {
          "@type": "SearchAction",
          target: `${SITE_URL}/search?q={search_term_string}`,
          "query-input": "required name=search_term_string",
        },
      };

    case "person":
      return {
        ...baseData,
        name: data.displayName || data.name,
        alternateName: data.name,
        description: data.description,
        url: `${SITE_URL}/agent/${data.name}`,
      };

    default:
      return baseData;
  }
}

// Script component for JSON-LD
export function JsonLdScript({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

// Breadcrumb JSON-LD
export function generateBreadcrumbJsonLd(
  items: { name: string; url: string }[]
) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: `${SITE_URL}${item.url}`,
    })),
  };
}
