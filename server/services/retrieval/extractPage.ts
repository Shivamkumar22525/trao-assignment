import { load } from "cheerio";
import type { ExtractedPage } from "./types.js";

const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,dt,dd,blockquote";

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[\t\r\n ]+/g, " ").trim();
}

function isBoilerplateLine(value: string): boolean {
  return /^(?:cookie settings|we use cookies|privacy choices|all rights reserved|skip to content)$/i.test(value);
}

/** Deterministically extracts visible page content; extracted text is always data, never instructions. */
export function extractPage(html: string): ExtractedPage {
  const $ = load(html);
  $("script,style,noscript,svg,iframe,template,nav,footer,form,button,[role='navigation'],[aria-hidden='true'],[hidden]").remove();
  $("[style*='display:none'],[style*='display: none'],[style*='visibility:hidden'],[style*='visibility: hidden']").remove();
  $(".cookie-banner,.cookie-consent,.privacy-banner,#cookie-banner,#cookie-consent,#privacy-banner").remove();

  const title = normalizeText($("title").first().text() || $("h1").first().text());
  const description = normalizeText(
    $("meta[name='description']").attr("content")
      || $("meta[property='og:description']").attr("content")
      || "",
  );

  const blocks: string[] = [];
  $("body").find(BLOCK_SELECTOR).each((_index, element) => {
    const node = $(element);
    // Parent list/quote text already includes nested paragraphs; avoid duplicates.
    if (node.parents("li,blockquote").length > 0) return;
    const text = normalizeText(node.text());
    if (text && !isBoilerplateLine(text)) blocks.push(text);
  });

  const bodyText = normalizeText($("body").text());
  const usefulBlocks = blocks.length >= 2 ? blocks : (bodyText ? [bodyText] : []);
  const text = usefulBlocks.filter((line) => !isBoilerplateLine(line)).join("\n");

  const links = $("a[href]").toArray().map((element) => {
    const node = $(element);
    const imageAlt = normalizeText(node.find("img[alt]").first().attr("alt") ?? "");
    return {
      anchorText: normalizeText(node.text()) || imageAlt || normalizeText(node.attr("aria-label") ?? ""),
      href: normalizeText(node.attr("href") ?? ""),
    };
  }).filter(({ href }) => href.length > 0);

  return { title, description, text, links };
}
