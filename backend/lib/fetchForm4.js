const axios = require('axios');
const cheerio = require('cheerio');

async function getLatestForm4Filings(symbol) {
  try {
    // Get company CIK
    const cikRes = await axios.get(
      `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${symbol}&type=4&dateb=&owner=exclude&count=10&search_text=`
    );
    
    const $ = cheerio.load(cikRes.data);
    const filings = [];
    
    // Parse Form 4 entries (last 10)
    $('table.tableFile2 tr').slice(1).each((i, row) => {
      const cells = $(row).find('td');
      
      if (cells.length >= 4) {
        const filing = {
          date: $(cells[3]).text().trim(),
          filingUrl: $(cells[1]).find('a').attr('href'),
          symbol: symbol
        };
        
        filings.push(filing);
      }
    });
    
    // Get details of most recent filing
    if (filings.length > 0) {
      const recentUrl = `https://www.sec.gov${filings[0].filingUrl}`;
      const filingRes = await axios.get(recentUrl);
      const filingHtml = cheerio.load(filingRes.data);
      
      // Extract transaction details
      const transactions = [];
      filingHtml('.formData tr').each((i, row) => {
        const cells = filingHtml(row).find('td');
        if (cells.length >= 5) {
          transactions.push({
            transactionType: filingHtml(cells[1]).text().trim(),
            quantity: parseInt(filingHtml(cells[2]).text()) || 0,
            price: parseFloat(filingHtml(cells[3]).text()) || 0,
            date: filingHtml(cells[4]).text().trim()
          });
        }
      });
      
      return {
        date: filings[0].date,
        transactionCount: transactions.length,
        isBuying: transactions.some(t => t.transactionType.includes('Buy')),
        transactions: transactions.slice(0, 3) // Top 3 transactions
      };
    }
    
    return null;
  } catch (error) {
    console.error(`Form 4 error for ${symbol}:`, error.message);
    return null;
  }
}

module.exports = { getLatestForm4Filings };
