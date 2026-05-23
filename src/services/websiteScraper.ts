import axios from 'axios';
import * as cheerio from 'cheerio';

interface ScrapedCompanyInfo {
  extractedText: string;
  foundEmails: string[];
}

/**
 * Scrapes a company domain home page, extracts text content, and crawls for email addresses.
 */
export async function scrapeCompanyWebsite(domain: string): Promise<ScrapedCompanyInfo> {
  const urlsToTry = [
    `https://${domain}`,
    `http://${domain}`,
    `https://www.${domain}`
  ];

  let html = '';
  let finalUrl = '';
  
  // Try to connect to domain
  for (const url of urlsToTry) {
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 8000,
        maxRedirects: 5
      });
      html = response.data;
      finalUrl = response.config.url || url;
      break;
    } catch {
      // Continue to next URL pattern
    }
  }

  if (!html) {
    throw new Error(`Could not access domain: ${domain}`);
  }

  const $ = cheerio.load(html);
  
  // Clean up code tags to leave readable text
  $('script, style, iframe, noscript, svg, header, footer, nav').remove();

  // Extract meta description and headings
  const metaDescription = $('meta[name="description"]').attr('content') || '';
  const title = $('title').text() || '';
  const h1Texts: string[] = [];
  $('h1').each((_, el) => { h1Texts.push($(el).text().trim()); });
  const h2Texts: string[] = [];
  $('h2').each((_, el) => { h2Texts.push($(el).text().trim()); });

  // Extract body paragraphs text
  const paragraphs: string[] = [];
  $('p').each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 30 && paragraphs.length < 15) {
      paragraphs.push(text);
    }
  });

  const bodyText = paragraphs.join(' ');
  const combinedText = `
    Title: ${title}
    Meta Description: ${metaDescription}
    Primary Headings: ${h1Texts.slice(0, 5).join(' | ')}
    Secondary Headings: ${h2Texts.slice(0, 5).join(' | ')}
    Body Text Excerpt: ${bodyText.slice(0, 1500)}
  `.trim();

  // Extract emails using regex
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const pageText = $('html').text();
  let foundEmails: string[] = [];
  let match;
  
  while ((match = emailRegex.exec(pageText)) !== null) {
    const email = match[0].toLowerCase();
    // Exclude noise / common non-inbox patterns
    if (!email.endsWith('.png') && !email.endsWith('.jpg') && !email.endsWith('.jpeg') && !email.endsWith('.gif') && !email.includes('sentry.io') && !email.includes('bootstrap')) {
      foundEmails.push(email);
    }
  }

  // Remove duplicates
  foundEmails = [...new Set(foundEmails)];

  // If no email found on homepage, try to look at /contact or /about pages
  if (foundEmails.length === 0) {
    const contactLinks: string[] = [];
    $('a').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().toLowerCase();
      if (href && (text.includes('contact') || text.includes('about') || text.includes('careers') || text.includes('support'))) {
        try {
          const absoluteUrl = new URL(href, finalUrl).toString();
          contactLinks.push(absoluteUrl);
        } catch {
          // ignore invalid relative links
        }
      }
    });

    const uniqueLinks = [...new Set(contactLinks)].slice(0, 2);
    for (const link of uniqueLinks) {
      try {
        const res = await axios.get(link, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          timeout: 5000
        });
        const contactPageText = cheerio.load(res.data)('html').text();
        let contactMatch;
        while ((contactMatch = emailRegex.exec(contactPageText)) !== null) {
          const email = contactMatch[0].toLowerCase();
          if (!email.endsWith('.png') && !email.endsWith('.jpg') && !email.endsWith('.jpeg') && !email.includes('sentry.io')) {
            foundEmails.push(email);
          }
        }
      } catch {
        // Continue if subpage load fails
      }
    }
    foundEmails = [...new Set(foundEmails)];
  }

  // Filter found emails to prioritize common generic business addresses if many found
  // (e.g. jobs@, hello@, contact@, info@, engineering@)
  const prioritized = foundEmails.filter(e => 
    e.startsWith('hello@') || 
    e.startsWith('contact@') || 
    e.startsWith('info@') || 
    e.startsWith('careers@') || 
    e.startsWith('jobs@') || 
    e.startsWith('engineering@') || 
    e.startsWith('press@') ||
    e.startsWith('hi@')
  );

  return {
    extractedText: combinedText,
    foundEmails: prioritized.length > 0 ? prioritized : foundEmails
  };
}
