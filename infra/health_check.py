# Uçtan uca sağlık kontrolü: CloudFront üzerinden /api/health çağrılır (CloudFront + EC2 + uygulama birlikte).
# Başarısızlıkta istisna fırlatılır; CloudWatch alarmı Lambda'nın Errors metriğini izler.
import os
import urllib.request

URL = os.environ["HEALTH_URL"]
TIMEOUT_SECONDS = 10


def handler(event, context):
    with urllib.request.urlopen(URL, timeout=TIMEOUT_SECONDS) as response:
        if response.status != 200:
            raise RuntimeError(f"Sağlık kontrolü başarısız: HTTP {response.status}")
        return {"status": response.status}
