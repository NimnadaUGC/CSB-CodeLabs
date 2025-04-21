// filepath: netlify/functions/server.js
const express = require('express');
const serverless = require('serverless-http');

const app = express();

app.use(express.json());

app.get('/api/compiler', (req, res) => {
    res.json({ message: 'Hello from the backend!' });
});

module.exports.handler = serverless(app);