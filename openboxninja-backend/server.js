// OpenBoxNinja Backend Server - Simplified with amazon-paapi library
// Install: npm install express cors dotenv node-cache amazon-paapi

const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');
const amazonPaapi = require('amazon-paapi');
require('dotenv').config();

const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // Cache for 1 hour

app.use(cors());
app.use(express.json());

// Configure Amazon PA-API client
const commonParameters = {
  AccessKey: process.env.AMAZON_ACCESS_KEY,
  SecretKey: process.env.AMAZON_SECRET_KEY,
  PartnerTag: process.env.AMAZON_PARTNER_TAG,
  PartnerType: 'Associates',
  Marketplace: 'www.amazon.com'
};

// Category mapping for Amazon search indices
const categoryMap = {
  'electronics': 'Electronics',
  'home': 'HomeAndKitchen',
  'sports': 'SportsAndOutdoors',
  'tools': 'ToolsAndHomeImprovement',
  'toys': 'ToysAndGames',
  'books': 'Books',
  'all': 'All'
};

// Condition mapping
const conditionMap = {
  'like-new': 'Used',
  'very-good': 'Used',
  'good': 'Used',
  'acceptable': 'Used',
  'all': 'Any'
};

// Endpoint: Search Amazon products
app.post('/api/search', async (req, res) => {
  try {
    const { 
      keywords = '', 
      categories = [],
      conditions = [],
      minPrice = null,
      maxPrice = null,
      minDiscount = 0
    } = req.body;

    // Build cache key
    const cacheKey = `search_${keywords}_${categories.join(',')}_${conditions.join(',')}_${minPrice}_${maxPrice}_${minDiscount}`;
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      console.log('✓ Returning cached data');
      return res.json(cachedData);
    }

    console.log('→ Fetching from Amazon API...');

    // Prepare search parameters
    const searchIndex = categories.length === 1 ? categoryMap[categories[0]] : 'All';
    const searchKeywords = keywords || 'warehouse deals';

    const requestParameters = {
      ...commonParameters,
      Keywords: searchKeywords,
      SearchIndex: searchIndex,
      ItemCount: 10,
      Resources: [
        'Images.Primary.Large',
        'ItemInfo.Title',
        'ItemInfo.Features',
        'ItemInfo.ByLineInfo',
        'Offers.Listings.Price',
        'Offers.Listings.Condition',
        'Offers.Listings.SavingBasis',
        'BrowseNodeInfo.BrowseNodes'
      ],
      Condition: 'Used', // Focus on used/open-box items
      MinPrice: minPrice ? minPrice * 100 : undefined, // Convert to cents
      MaxPrice: maxPrice ? maxPrice * 100 : undefined
    };

    // Make API request
    const data = await amazonPaapi.SearchItems(requestParameters);
    
    if (!data.SearchResult?.Items) {
      return res.json({ products: [], count: 0 });
    }

    // Transform and filter products
    let products = data.SearchResult.Items.map(item => transformProduct(item))
      .filter(product => product !== null);

    // Apply additional filters
    if (conditions.length > 0) {
      products = products.filter(p => 
        conditions.some(c => p.condition.toLowerCase().includes(c.replace('-', ' ')))
      );
    }

    if (minDiscount > 0) {
      products = products.filter(p => p.discount >= minDiscount);
    }

    const result = {
      products,
      count: products.length,
      timestamp: new Date().toISOString()
    };

    // Cache the results
    cache.set(cacheKey, result);
    console.log(`✓ Found ${products.length} products`);
    
    res.json(result);
  } catch (error) {
    console.error('❌ Search error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch products',
      message: error.message,
      products: [],
      count: 0
    });
  }
});

// Endpoint: Get specific product by ASIN
app.get('/api/product/:asin', async (req, res) => {
  try {
    const { asin } = req.params;
    
    // Check cache
    const cacheKey = `product_${asin}`;
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      console.log(`✓ Returning cached product: ${asin}`);
      return res.json(cachedData);
    }

    console.log(`→ Fetching product ${asin} from Amazon API...`);

    const requestParameters = {
      ...commonParameters,
      ItemIds: [asin],
      Resources: [
        'Images.Primary.Large',
        'Images.Variants.Large',
        'ItemInfo.Title',
        'ItemInfo.Features',
        'ItemInfo.ByLineInfo',
        'ItemInfo.ContentInfo',
        'Offers.Listings.Price',
        'Offers.Listings.Condition',
        'Offers.Listings.SavingBasis',
        'BrowseNodeInfo.BrowseNodes'
      ]
    };

    const data = await amazonPaapi.GetItems(requestParameters);
    
    if (!data.ItemsResult?.Items?.[0]) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = transformProduct(data.ItemsResult.Items[0]);
    
    if (!product) {
      return res.status(404).json({ error: 'Product not available' });
    }

    cache.set(cacheKey, product);
    console.log(`✓ Product fetched: ${product.title}`);
    
    res.json(product);
  } catch (error) {
    console.error('❌ Product detail error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch product details',
      message: error.message 
    });
  }
});

// Endpoint: Get warehouse deals by category
app.get('/api/warehouse-deals/:category', async (req, res) => {
  try {
    const { category } = req.params;
    const cacheKey = `warehouse_${category}`;
    const cachedData = cache.get(cacheKey);
    
    if (cachedData) {
      return res.json(cachedData);
    }

    const searchIndex = categoryMap[category] || 'All';
    
    const requestParameters = {
      ...commonParameters,
      Keywords: 'Amazon Warehouse',
      SearchIndex: searchIndex,
      ItemCount: 10,
      Condition: 'Used',
      Resources: [
        'Images.Primary.Large',
        'ItemInfo.Title',
        'ItemInfo.Features',
        'Offers.Listings.Price',
        'Offers.Listings.Condition',
        'Offers.Listings.SavingBasis'
      ]
    };

    const data = await amazonPaapi.SearchItems(requestParameters);
    
    const products = data.SearchResult?.Items?.map(item => transformProduct(item))
      .filter(p => p !== null) || [];

    const result = { products, count: products.length };
    cache.set(cacheKey, result);
    
    res.json(result);
  } catch (error) {
    console.error('Warehouse deals error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch warehouse deals',
      products: [],
      count: 0
    });
  }
});

// Transform Amazon product to our format
function transformProduct(item) {
  try {
    const offer = item.Offers?.Listings?.[0];
    
    if (!offer) {
      return null; // Skip items without offers
    }

    const currentPrice = offer.Price?.Amount || 0;
    const originalPrice = offer.SavingBasis?.Amount || currentPrice;
    const discount = originalPrice > 0 
      ? Math.round(((originalPrice - currentPrice) / originalPrice) * 100)
      : 0;

    const savings = (originalPrice - currentPrice) / 100;

    // Only return items with actual discounts
    if (discount === 0 || savings <= 0) {
      return null;
    }

    return {
      id: item.ASIN,
      asin: item.ASIN,
      title: item.ItemInfo?.Title?.DisplayValue || 'Unknown Product',
      brand: item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue || '',
      category: mapCategory(item.BrowseNodeInfo),
      condition: formatCondition(offer.Condition?.Value),
      currentPrice: currentPrice / 100,
      originalPrice: originalPrice / 100,
      discount,
      savings,
      image: item.Images?.Primary?.Large?.URL || 'https://via.placeholder.com/400x300?text=No+Image',
      affiliateUrl: item.DetailPageURL || '',
      features: item.ItemInfo?.Features?.DisplayValues || []
    };
  } catch (error) {
    console.error('Error transforming product:', error.message);
    return null;
  }
}

// Map Amazon categories to our simplified categories
function mapCategory(browseNodeInfo) {
  if (!browseNodeInfo?.BrowseNodes?.[0]) return 'electronics';
  
  const nodeName = browseNodeInfo.BrowseNodes[0].DisplayName?.toLowerCase() || '';
  
  if (nodeName.includes('electronic') || nodeName.includes('computer')) return 'electronics';
  if (nodeName.includes('home') || nodeName.includes('kitchen')) return 'home';
  if (nodeName.includes('sport') || nodeName.includes('outdoor')) return 'sports';
  if (nodeName.includes('tool') || nodeName.includes('improvement')) return 'tools';
  if (nodeName.includes('toy') || nodeName.includes('game')) return 'toys';
  if (nodeName.includes('book')) return 'books';
  
  return 'electronics';
}

// Format condition string
function formatCondition(condition) {
  if (!condition) return 'used';
  
  const conditionLower = condition.toLowerCase();
  
  if (conditionLower.includes('new')) return 'like-new';
  if (conditionLower.includes('very good')) return 'very-good';
  if (conditionLower.includes('good')) return 'good';
  if (conditionLower.includes('acceptable')) return 'acceptable';
  
  return 'used';
}

// Health check
app.get('/api/health', (req, res) => {
  const isConfigured = 
    process.env.AMAZON_ACCESS_KEY && 
    process.env.AMAZON_SECRET_KEY && 
    process.env.AMAZON_PARTNER_TAG;

  res.json({ 
    status: isConfigured ? 'OK' : 'MISSING_CREDENTIALS',
    timestamp: new Date().toISOString(),
    cache: {
      keys: cache.keys().length,
      hits: cache.getStats().hits,
      misses: cache.getStats().misses
    },
    config: {
      accessKey: process.env.AMAZON_ACCESS_KEY ? '✓ Set' : '✗ Missing',
      secretKey: process.env.AMAZON_SECRET_KEY ? '✓ Set' : '✗ Missing',
      partnerTag: process.env.AMAZON_PARTNER_TAG ? '✓ Set' : '✗ Missing'
    }
  });
});

// Clear cache
app.post('/api/cache/clear', (req, res) => {
  const keysCleared = cache.keys().length;
  cache.flushAll();
  res.json({ 
    message: 'Cache cleared',
    keysCleared 
  });
});

// Get cache stats
app.get('/api/cache/stats', (req, res) => {
  res.json({
    keys: cache.keys(),
    stats: cache.getStats()
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('\n🥷 OpenBoxNinja API Server Started');
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🔍 Health: http://localhost:${PORT}/api/health`);
  console.log('\nConfiguration:');
  console.log(`  Access Key: ${process.env.AMAZON_ACCESS_KEY ? '✓' : '✗'}`);
  console.log(`  Secret Key: ${process.env.AMAZON_SECRET_KEY ? '✓' : '✗'}`);
  console.log(`  Partner Tag: ${process.env.AMAZON_PARTNER_TAG ? '✓' : '✗'}`);
  console.log('\n');
});
