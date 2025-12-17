const express = require('express');
const client = require('prom-client');

const app = express();
const register = new client.Registry();

// métricas default (CPU, memoria, etc)
client.collectDefaultMetrics({ register });

// contador HTTP por status
const httpCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'status']
});

register.registerMetric(httpCounter);

// endpoints
app.get('/', (req, res) => {
  httpCounter.inc({ method: 'GET', status: '200' });
  res.send('OK');
});

app.get('/error', (req, res) => {
  httpCounter.inc({ method: 'GET', status: '500' });
  res.status(500).send('ERROR');
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.listen(3000, () => {
  console.log('App running on port 3000');
});
