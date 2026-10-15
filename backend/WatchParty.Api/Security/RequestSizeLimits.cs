using Microsoft.AspNetCore.Http.Metadata;

namespace WatchParty.Api.Security;

public static class RequestSizeLimits
{
    /// <summary>
    /// Uç noktada <see cref="IRequestSizeLimitMetadata"/> varsa ve Content-Length sınırı aşıyorsa model bağlamadan
    /// önce 413 döner. Content-Length'siz (chunked) gövdeleri Kestrel, yönlendirmenin aynı metadata'dan ayarladığı
    /// MaxRequestBodySize ile okurken keser; bu ara katman o özelliğin olmadığı ortamlarda (TestServer) da sınırı korur.
    /// </summary>
    public static IApplicationBuilder UseRequestSizeLimitMetadata(this IApplicationBuilder app) =>
        app.Use(async (context, next) =>
        {
            var limit = context.GetEndpoint()?.Metadata.GetMetadata<IRequestSizeLimitMetadata>()?.MaxRequestBodySize;
            if (limit is not null && context.Request.ContentLength > limit)
            {
                context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
                return;
            }
            await next(context);
        });
}
