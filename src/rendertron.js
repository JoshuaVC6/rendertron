"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Koa = require("koa");
const bodyParser = require("koa-bodyparser");
const koaCompress = require("koa-compress");
const route = require("koa-route");
const koaSend = require("koa-send");
const koaLogger = require("koa-logger");
const path = require("path");
const puppeteer = require("puppeteer");
const url = require("url");
const renderer_1 = require("./renderer");
const config_1 = require("./config");
const axios = require('axios');
const qs = require('qs');
const https = require("https");
/**
 * Rendertron rendering service. This runs the server which routes rendering
 * requests through to the renderer.
 */
class Rendertron {
    constructor() {
        this.app = new Koa();
        this.config = config_1.ConfigManager.config;
        this.port = process.env.PORT;
    }
    async initialize() {
        // Load config
        this.config = await config_1.ConfigManager.getConfiguration();
        this.port = this.port || this.config.port;
        const browser = await puppeteer.launch({
            args: ['--no-sandbox', '--lang=es'],
            defaultViewport: null,
        });
        this.renderer = new renderer_1.Renderer(browser, this.config);
        this.app.use(koaLogger());
        this.app.use(koaCompress());
        this.app.use(bodyParser());
        this.app.use(route.get('/', async (ctx) => {
            await koaSend(ctx, 'index.html', { root: path.resolve(__dirname, '../src') });
        }));

        this.app.use(route.get('/puppeteer/:id', async (ctx) => {
            let id = ctx.request.url
            id = id.split("/")
            id = id[id.length - 1]
            console.log("hola")
            let productos
            try {
                let data = qs.stringify({
                    'search': `search index=vtex_orders items{}.additionalInfo.categories{}.id=${id} status="*nvoic*" earliest=-15d@d latest=now\n\n| spath orderId\n| dedup orderId\n\n| spath items{}.name output=producto\n| spath items{}.id output=sku\n| spath items{}.sellingPrice output=precio\n| spath items{}.quantity output=cantidad\n\n| eval zip=mvzip(producto, sku, "Ø")\n| eval zip=mvzip(zip, precio, "Ø")\n| eval zip=mvzip(zip, cantidad, "Ø")\n| mvexpand zip\n| eval split=split(zip, "Ø")\n| eval producto=mvindex(split, 0)\n| eval sku=mvindex(split, 1)\n| eval precio=mvindex(split, 2)\n| eval cantidad=mvindex(split, 3)\n\n| eval precio=precio/100\n\n| eval vendidoPorOrden = precio * cantidad\n\n| eventstats sum(vendidoPorOrden) by sku\n| rename sum(vendidoPorOrden) as totalVentas\n| eval totalVentas = round(totalVentas, 2)\n\n| dedup sku\n| table producto sku totalVentas\n| sort 50 -totalVentas`,
                    'output_mode': 'json'
                });
                process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
                let config = {
                    method: 'post',
                    maxBodyLength: Infinity,
                    responseType: 'json',
                    url: 'https://3.88.51.104:8089/services/search/jobs/export',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': 'Basic YXBwa2V5aGF5Y2FzaDpoYXljYXNoMDgxMjIz'
                    },
                    data: data
                };

                let response = await axios.request(config)
                response = response.data
                response = response.replaceAll("}}", "}},")
                response = "[" + response + "]"
                response = response.replaceAll("}},\n]", "}}]")
                productos = JSON.parse(response)
            } catch (error) {
                console.log(JSON.stringify(error))
            }
            let condition = 0
            for (let iterador = 0; iterador < 100; iterador++) {
                let data2Splunk = {
                    "sku": productos[iterador].result.sku,
                    "totals": []
                }
                let producto = productos[iterador].result.producto
                console.log(iterador)
                console.log(producto)
                try {
                    let page = await browser.newPage()
                    await page.setGeolocation({ latitude: 19.4326, longitude: -99.1332 });
                    let firstLink = `https://www.google.com//search?sca_esv=601452934&q=${producto}&tbm=shop&source=lnms`
                    firstLink = firstLink.replace(" ", "+")
                    console.log(firstLink)
                    await page.goto(firstLink)
                    //await page.screenshot({ path: `./new.jpg` });
                    await page.waitForSelector('.u30d4');
                    let productDetails = await page.$$eval('.u30d4', elements => {
                        return elements.map(element => {
                            try {
                                let productName = element.querySelector('.rgHvZc').innerText;
                                let productPrice = element.querySelector('.HRLxBb').innerText;
                                let vendorNamesElements = element.querySelectorAll('.dD8iuc');
                                let vendorNames = Array.from(vendorNamesElements).map(element => element.innerText);

                                return { productName, productPrice, vendorNames };
                            } catch (error) {
                                console.error("Error al procesar el elemento:", error.message);
                                return null;
                            }
                        }).filter(details => details !== null);
                    });
                    let productArrays = [], iterador3 = -1
                    do {
                        iterador3++
                        let vendor = ""
                        for (let iterador2 in productDetails[iterador3].vendorNames) {
                            vendor = ""
                            if (productDetails[iterador3].vendorNames[iterador2].includes("MXN")) {
                                vendor = productDetails[iterador3].vendorNames[iterador2].split("en ")
                                vendor = vendor[1]
                                productDetails[iterador3].vendorNames = vendor
                            }
                        }
                        if (!productDetails[iterador3].productPrice.includes("mensuales") && !productDetails[iterador3].productPrice.includes("más impuestos")) {
                            var coincidencia = productDetails[iterador3].productPrice.match(/(\d{1,3}(,\d{3})*(\.\d{1,2})?|\.\d{1,2})/);
                            productDetails[iterador3].productPrice = parseFloat(coincidencia[0].replace(/[^\d.]/g, ''));
                            productArrays.push(productDetails[iterador3])
                        }
                    } while (productArrays.length <= 4);

                    ctx.body = productArrays;
                    data2Splunk.totals = productArrays
                    console.log('Product Details:', data2Splunk);
                } catch (e) {
                    console.log(JSON.stringify(e))
                }
                if (data2Splunk.totals != []) {
                    condition++
                    try {
                        let splunkHeaders = {
                            Authorization: 'Splunk 8d65bc32-1293-4b2b-a74b-dad51aa6e3cb',
                            "Content-Type": "application/json",
                        };

                        const httpsAgent = new https.Agent({
                            rejectUnauthorized: false,
                        });

                        const response = await axios.post('https://3.88.51.104:8088/services/collector/raw', JSON.stringify(data2Splunk), {
                            headers: splunkHeaders,
                            httpsAgent: httpsAgent,
                        });
                        console.log(response.data)
                    } catch (error) {
                        console.log(JSON.stringify(e))
                    }
                }
                if (condition == 50) break;
            }

        }));


        this.app.use(route.get('/_ah/health', (ctx) => ctx.body = 'OK'));
        // Optionally enable cache for rendering requests.
        if (this.config.datastoreCache) {
            const { DatastoreCache } = await Promise.resolve().then(() => require('./datastore-cache'));
            this.app.use(new DatastoreCache().middleware());
        }
        this.app.use(route.get('/render/:url(.*)', this.handleRenderRequest.bind(this)));
        this.app.use(route.get('/screenshot/:url(.*)', this.handleScreenshotRequest.bind(this)));
        this.app.use(route.post('/screenshot/:url(.*)', this.handleScreenshotRequest.bind(this)));
        return this.app.listen(this.port, () => {
            console.log(`Listening on port ${this.port}`);
        });
    }
    /**
     * Checks whether or not the URL is valid. For example, we don't want to allow
     * the requester to read the file system via Chrome.
     */
    restricted(href) {
        const parsedUrl = url.parse(href);
        const protocol = parsedUrl.protocol || '';
        if (!protocol.match(/^https?/)) {
            return true;
        }
        return false;
    }
    async handleRenderRequest(ctx, url) {
        if (!this.renderer) {
            throw (new Error('No renderer initalized yet.'));
        }
        if (this.restricted(url)) {
            ctx.status = 403;
            return;
        }
        const mobileVersion = 'mobile' in ctx.query ? true : false;
        const serialized = await this.renderer.serialize(url, mobileVersion);
        // Mark the response as coming from Rendertron.
        ctx.set('x-renderer', 'rendertron');
        ctx.status = serialized.status;
        ctx.body = serialized.content;
    }
    async handleScreenshotRequest(ctx, url) {
        if (!this.renderer) {
            throw (new Error('No renderer initalized yet.'));
        }
        if (this.restricted(url)) {
            ctx.status = 403;
            return;
        }
        let options = undefined;
        if (ctx.method === 'POST' && ctx.request.body) {
            options = ctx.request.body;
        }
        const dimensions = {
            width: Number(ctx.query['width']) || this.config.width,
            height: Number(ctx.query['height']) || this.config.height
        };
        const mobileVersion = 'mobile' in ctx.query ? true : false;
        try {
            const img = await this.renderer.screenshot(url, mobileVersion, dimensions, options);
            ctx.set('Content-Type', 'image/jpeg');
            ctx.set('Content-Length', img.length.toString());
            ctx.body = img;
        }
        catch (error) {
            const err = error;
            ctx.status = err.type === 'Forbidden' ? 403 : 500;
        }
    }
}
exports.Rendertron = Rendertron;
async function logUncaughtError(error) {
    console.error('Uncaught exception');
    console.error(error);
    process.exit(1);
}
// Start rendertron if not running inside tests.
if (!module.parent) {
    const rendertron = new Rendertron();
    rendertron.initialize();
    process.on('uncaughtException', logUncaughtError);
    process.on('unhandledRejection', logUncaughtError);
}
//# sourceMappingURL=rendertron.js.map