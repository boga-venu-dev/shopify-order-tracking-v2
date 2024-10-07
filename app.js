const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');

const app = express();
app.use(express.json());

// Initialize cache
const cache = new NodeCache({ stdTTL: 3600 }); // Cache for 1 hour

// Add CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://your-shopify-store.myshopify.com');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

const SHOP = process.env.SHOPIFY_SHOP_NAME;
const API_PASSWORD = process.env.SHOPIFY_API_PASSWORD;
const API_VERSION = '2023-04';

const shopifyApi = axios.create({
  baseURL: `https://${SHOP}/admin/api/${API_VERSION}`,
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': API_PASSWORD
  },
});

app.post('/get_orders', async (req, res) => {
  const { contact_type, contact_info } = req.body;
  console.log('Received request:', { contact_type, contact_info });

  const cacheKey = `${contact_type}-${contact_info}`;

  try {
    // Check cache first
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      console.log('Returning cached result for:', cacheKey);
      return res.json(cachedResult);
    }

    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    
    // Fetch orders
    const response = await shopifyApi.get('/orders.json', {
      params: {
        status: 'any',
        created_at_min: oneYearAgo,
        limit: 250,
        [contact_type]: contact_info,
        fields: 'id,order_number,created_at,total_price,fulfillment_status,line_items,shipping_address,email,phone'
      }
    });

    const orders = response.data.orders;
    console.log('Orders fetched:', orders.length);

    const orderSummaries = orders.map(order => ({
      order_number: order.order_number,
      created_at: order.created_at,
      total_price: order.total_price,
      fulfillment_status: order.fulfillment_status || 'unfulfilled',
      items_count: order.line_items.reduce((sum, item) => sum + item.quantity, 0)
    }));

    // Cache the result
    cache.set(cacheKey, orderSummaries);

    console.log('Sending response:', orderSummaries);
    res.json(orderSummaries);

  } catch (error) {
    console.error('Error fetching orders:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'An error occurred while fetching the order information' });
  }
});

app.post('/get_order_details', async (req, res) => {
  const { order_number } = req.body;
  console.log('Received request for order details:', { order_number });

  const cacheKey = `order-details-${order_number}`;

  try {
    // Check cache first
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      console.log('Returning cached result for:', cacheKey);
      return res.json(cachedResult);
    }

    // Fetch specific order
    const response = await shopifyApi.get(`/orders.json?name=${order_number}`);
    const order = response.data.orders[0];

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const orderDetails = {
      order_number: order.order_number,
      created_at: order.created_at,
      total_price: order.total_price,
      fulfillment_status: order.fulfillment_status || 'unfulfilled',
      shipping_address: order.shipping_address,
      line_items: order.line_items.map(item => ({
        title: item.title,
        quantity: item.quantity,
        price: item.price
      })),
      tracking_info: order.fulfillments && order.fulfillments.length > 0 ? {
        tracking_number: order.fulfillments[0].tracking_number,
        tracking_company: order.fulfillments[0].tracking_company,
        tracking_url: order.fulfillments[0].tracking_url,
      } : null
    };

    // Cache the result
    cache.set(cacheKey, orderDetails);

    console.log('Sending response:', orderDetails);
    res.json(orderDetails);

  } catch (error) {
    console.error('Error fetching order details:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'An error occurred while fetching the order details' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
