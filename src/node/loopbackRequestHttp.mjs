// Shared request gate for host-authority middlewares. Defends the dev server
// against DNS rebinding (Host must name a loopback host), LAN callers when the
// listener is exposed (socket peer must be loopback), and cross-site browsers
// (Origin must equal the Host origin; a same-origin GET without Origin is
// accepted only when the browser-controlled Sec-Fetch-Site says same-origin).
const LOOPBACK_HOST=/^(?:localhost|127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|\[::1\])(?::\d{1,5})?$/i;
export const isLoopbackHost=host=>typeof host==='string'&&LOOPBACK_HOST.test(host);
export const isLoopbackAddress=address=>typeof address==='string'&&(address==='::1'||/^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(address));
export function isSameOriginLoopbackRequest(req){
 const {host,origin}=req.headers;
 if(!isLoopbackHost(host)||!isLoopbackAddress(req.socket?.remoteAddress))return false;
 if(origin!==undefined)return origin===`http://${host}`||origin===`https://${host}`;
 return req.headers['sec-fetch-site']==='same-origin';
}
