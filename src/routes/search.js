const express = require('express');
const router = express.Router();
const SearchController = require('../controllers/SearchController');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');

router.use(auth, tenancy);

router.get('/', (req, res, next) => SearchController.search(req, res, next));

module.exports = router;
