import Parser from 'rss-parser';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { query } from '../db/client.js';

interface RawLead {
  companyName: string;
  jobTitle: string;
  jobDescription: string;
  sourceUrl: string;
}

const parser = new Parser();

// Cleaning utility for company names (e.g. "Acme Corp" -> "Acme")
function cleanCompanyName(name: string): string {
  return name
    .replace(/\b(inc|corp|co|ltd|gmbh|llc|srl|sa)\b\.?/gi, '')
    .trim();
}

/**
 * Attempts to extract the company domain name from job page HTML or application links
 */
async function extractDomain(jobUrl: string, companyName: string): Promise<string | null> {
  try {
    const response = await axios.get(jobUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });
    
    const $ = cheerio.load(response.data);
    let domainUrl: string | null = null;

    // Check for explicit "Company Website" links in We Work Remotely
    $('a').each((_, element) => {
      const href = $(element).attr('href');
      const text = $(element).text().toLowerCase();
      
      if (href && (text.includes('website') || text.includes('company site') || text.includes('homepage'))) {
        domainUrl = href;
        return false; // break loop
      }
    });

    // Fallback: look at the apply button/link
    if (!domainUrl) {
      const applyHref = $('.apply-button, a[href*="lever.co"], a[href*="greenhouse.io"], a[href*="workable.com"]').first().attr('href');
      if (applyHref) {
        domainUrl = applyHref;
      }
    }

    // Fallback 2: look at general outgoing links that don't match weworkremotely
    if (!domainUrl) {
      $('a').each((_, element) => {
        const href = $(element).attr('href');
        if (href && href.startsWith('http') && !href.includes('weworkremotely.com') && !href.includes('twitter.com') && !href.includes('facebook.com') && !href.includes('linkedin.com')) {
          domainUrl = href;
          return false;
        }
      });
    }

    if (domainUrl) {
      const urlObj = new URL(domainUrl);
      let host = urlObj.hostname.replace('www.', '');
      
      // If it's greenhouse or lever, clean it to get the path segment or just keep it
      if (host.includes('lever.co') || host.includes('greenhouse.io') || host.includes('workable.com')) {
        // Try to guess company domain from name
        return `${cleanCompanyName(companyName).toLowerCase().replace(/[^a-z0-9]/g, '')}.com`;
      }
      
      return host;
    }
  } catch (error) {
    console.error(`Error resolving domain for ${companyName} at ${jobUrl}:`, error instanceof Error ? error.message : error);
  }

  // Final fallback: guess from company name
  return `${cleanCompanyName(companyName).toLowerCase().replace(/[^a-z0-9]/g, '')}.com`;
}

/**
 * Main scraper task: fetches feeds, extracts leads, searches for company domains,
 * and saves new leads in 'discovered' status to the database.
 */
export async function scrapeJobBoards() {
  console.log('Fetching remote backend engineering job postings...');
  const feeds = [
    'https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss'
  ];

  let newLeadsCount = 0;

  for (const feedUrl of feeds) {
    try {
      const feed = await parser.parseURL(feedUrl);
      console.log(`Parsed feed: ${feed.title}. Found ${feed.items.length} items.`);

      for (const item of feed.items) {
        if (!item.title || !item.link) continue;

        // We Work Remotely titles look like: "Company Name: Job Title"
        const parts = item.title.split(':');
        let companyName = '';
        let jobTitle = '';

        if (parts.length >= 2) {
          companyName = parts[0].trim();
          jobTitle = parts.slice(1).join(':').trim();
        } else {
          companyName = 'Unknown';
          jobTitle = item.title.trim();
        }

        // Only target US, UK, Europe clients as requested. Check content/title.
        const content = (item.contentSnippet || item.content || '').toLowerCase();
        const titleLower = item.title.toLowerCase();
        const locations = ['us', 'usa', 'united states', 'uk', 'united kingdom', 'europe', 'london', 'germany', 'france', 'canada'];
        
        const matchesLocation = locations.some(loc => 
          content.includes(loc) || titleLower.includes(loc)
        );

        if (!matchesLocation) {
          // If no location filter matches, skip to ensure we target premium geo leads
          continue;
        }

        // Check if lead domain/company is already in the database
        const domain = await extractDomain(item.link, companyName);
        if (!domain) continue;

        const checkRes = await query('SELECT id FROM leads WHERE domain = $1', [domain]);
        if (checkRes.rows.length > 0) {
          // Already exists, skip
          continue;
        }

        // Insert new lead in 'discovered' state
        await query(
          `INSERT INTO leads (company_name, domain, job_title, job_description, source_url, status)
           VALUES ($1, $2, $3, $4, $5, 'discovered')`,
          [companyName, domain, jobTitle, item.contentSnippet || '', item.link]
        );
        
        console.log(`Added new lead: ${companyName} (${domain}) - ${jobTitle}`);
        newLeadsCount++;
      }
    } catch (error) {
      console.error(`Error parsing feed ${feedUrl}:`, error);
    }
  }

  console.log(`Scraper execution finished. Discovered ${newLeadsCount} new leads.`);
  return newLeadsCount;
}
