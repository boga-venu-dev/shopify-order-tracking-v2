const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const { GraphQLClient, gql } = require('graphql-request');
const RateLimit = require('express-rate-limit');
const Queue = require('better-queue');
const helmet = require('helmet');
const winston = require('winston');

const app = express();

// Enable trust proxy
app.set('trust proxy', 1);

app.use(helmet());

app.use(express.json());

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  defaultMeta: { service: 'order-tracking' },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple(),
  }));
}

// Initialize cache
const cache = new NodeCache({ stdTTL: 3600, maxKeys: 1000 });

// Add CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', 'https://ramyanagendra.com');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

const SHOP = process.env.SHOPIFY_SHOP_NAME;
const API_PASSWORD = process.env.SHOPIFY_API_PASSWORD;
const API_VERSION = '2024-01';

logger.info('Shop Name:', SHOP);
logger.info('API Version:', API_VERSION);

const shopifyApi = axios.create({
  baseURL: `https://${SHOP}/admin/api/${API_VERSION}`,
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': API_PASSWORD
  },
});

const limiter = RateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

app.use(limiter);

// Request queue
const requestQueue = new Queue(async (task, cb) => {
  try {
    let result;
    if (task.type === 'email') {
      result = await searchOrdersByEmail(task.info);
    } else if (task.type === 'phone') {
      result = await searchOrdersByPhone(task.info);
    }
    cb(null, result);
  } catch (error) {
    cb(error);
  }
}, { concurrent: 5 }); // Process 5 requests concurrently

async function searchOrdersByEmail(email) {
  let allOrders = [];
  let nextPageUrl = `/orders.json?status=any&email=${encodeURIComponent(email)}&limit=250`;

  while (nextPageUrl) {
    try {
      const response = await shopifyApi.get(nextPageUrl);
      const orders = response.data.orders;
      allOrders = allOrders.concat(orders);

      // Check for next page
      const linkHeader = response.headers['link'];
      nextPageUrl = null;
      if (linkHeader) {
        const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (match) {
          nextPageUrl = match[1];
        }
      }
    } catch (error) {
      console.error('Error fetching orders:', error.response ? error.response.data : error.message);
      throw error;
    }
  }

  return allOrders.map(order => ({
    order_number: order.name,
    created_at: order.created_at,
    total_price: order.total_price,
    fulfillment_status: order.fulfillment_status || 'unfulfilled',
    items_count: order.line_items.reduce((sum, item) => sum + item.quantity, 0),
    shipping_address: order.shipping_address,
    tracking_info: order.fulfillments && order.fulfillments.length > 0 ? {
      tracking_number: order.fulfillments[0].tracking_number,
      tracking_company: order.fulfillments[0].tracking_company,
      tracking_url: order.fulfillments[0].tracking_url,
    } : null,
    line_items: order.line_items.map(item => ({
      title: item.title,
      quantity: item.quantity,
      price: item.price
    }))
  }));
}



const graphqlClient = new GraphQLClient(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
  headers: {
    'X-Shopify-Access-Token': API_PASSWORD,
  },
});

async function searchOrdersByPhone(phone) {
  // Step 1: Find customers by phone number
  const customerQuery = gql`
    query($query: String!) {
      customers(first: 250, query: $query) {
        edges {
          node {
            id
            displayName
            email
          }
        }
      }
    }
  `;

  const normalizedPhone = phone.replace(/\D/g, '');
  const customerVariables = {
    query: `phone:${normalizedPhone}`
  };

  const customerData = await graphqlClient.request(customerQuery, customerVariables);
  const customers = customerData.customers.edges.map(edge => edge.node);

  console.log(`Found ${customers.length} customers with phone ${normalizedPhone}`);

  // Step 2: Fetch orders for these customers
  const orderQuery = gql`
    query($customerId: ID!, $first: Int!) {
      customer(id: $customerId) {
        orders(first: $first) {
          edges {
            node {
              id
              name
              createdAt
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              displayFulfillmentStatus
              lineItems(first: 10) {
                edges {
                  node {
                    name
                    quantity
                    originalUnitPriceSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                  }
                }
              }
              shippingAddress {
                phone
                address1
                city
                province
                zip
                country
              }
              fulfillments(first: 1) {
                trackingInfo {
                  company
                  number
                  url
                }
              }
            }
          }
        }
      }
    }
  `;

  let allOrders = [];

  for (const customer of customers) {
    const orderVariables = {
      customerId: customer.id,
      first: 250  // Adjust this number as needed
    };

    const orderData = await graphqlClient.request(orderQuery, orderVariables);
    const customerOrders = orderData.customer.orders.edges.map(edge => ({
      ...edge.node,
      customerName: customer.displayName,
      customerEmail: customer.email
    }));

    allOrders = allOrders.concat(customerOrders);
  }

  allOrders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  console.log(`Total orders fetched and sorted: ${allOrders.length}`);

  return allOrders.map(order => ({
    order_number: order.name,
    created_at: order.createdAt,
    total_price: order.totalPriceSet.shopMoney.amount,
    currency_code: order.totalPriceSet.shopMoney.currencyCode,
    fulfillment_status: order.displayFulfillmentStatus,
    items_count: order.lineItems.edges.reduce((sum, edge) => sum + edge.node.quantity, 0),
    shipping_address: order.shippingAddress,
    tracking_info: order.fulfillments && order.fulfillments.length > 0 && order.fulfillments[0].trackingInfo.length > 0
      ? {
          tracking_company: order.fulfillments[0].trackingInfo[0].company,
          tracking_number: order.fulfillments[0].trackingInfo[0].number,
          tracking_url: order.fulfillments[0].trackingInfo[0].url,
        }
      : null,
    line_items: order.lineItems.edges.map(edge => ({
      title: edge.node.name,
      quantity: edge.node.quantity,
      price: edge.node.originalUnitPriceSet.shopMoney.amount
    })),
    customer_name: order.customerName,
    customer_email: order.customerEmail
  }));
}

app.post('/get_orders', async (req, res) => {
  const { contact_type, contact_info } = req.body;
  logger.info('Received request:', { contact_type, contact_info });

  const cacheKey = `${contact_type}-${contact_info}`;

  try {
    const cachedResult = cache.get(cacheKey);
    if (cachedResult) {
      logger.info('Returning cached result for:', cacheKey);
      return res.json(cachedResult);
    }

    let orders;
    if (contact_type === 'email') {
      orders = await searchOrdersByEmail(contact_info);
    } else if (contact_type === 'phone') {
      orders = await searchOrdersByPhone(contact_info);
    } else {
      return res.status(400).json({ error: 'Invalid contact type' });
    }

    logger.info('Total orders fetched:', orders.length);

    if (orders.length <= 1000) {
      cache.set(cacheKey, orders);
    }

    logger.info('Sending response:', orders.length, 'orders');
    res.json(orders);

  } catch (error) {
    logger.error('Error in /get_orders:', error.message);
    res.status(500).json({ error: 'An error occurred while fetching the order information' });
  }
});




const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
