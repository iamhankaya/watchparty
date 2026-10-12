// CloudFront Function (viewer-request, cloudfront-js-2.0): SPA yönlendirmesi.
// Son path segmentinde nokta olmayan istekler (/, /l/ABCDEF) /index.html'e yeniden yazılır;
// dosya istekleri (/assets/x.js, /favicon.ico) olduğu gibi S3'e gider.
// Yalnızca varsayılan (S3) behavior'a bağlıdır; /api/* ve /hubs/* etkilenmez.
function handler(event) {
  var request = event.request;
  var segments = request.uri.split("/");
  var last = segments[segments.length - 1];
  if (last.indexOf(".") === -1) {
    request.uri = "/index.html";
  }
  return request;
}
