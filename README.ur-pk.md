<div dir="rtl">

<p align="center">
  <img src="assets/mmargus_logo.jpeg" alt="MM-Argus logo" width="420">
</p>

# آرگس (Argus)

آرگس ایک ریئل ٹائم ملٹی موڈل AI ایجنٹ ہے۔ یہ شیئر کی گئی اسکرین یا کیمرہ دیکھ
سکتا ہے، صارف اور ماحول کی آواز سن سکتا ہے، حالیہ اور پچھلے مناظر کے بارے میں
سوالات کے جواب دے سکتا ہے، اور مسلسل نگرانی یا ویڈیو ریسرچ چلا سکتا ہے۔

[English](README.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md)

> آرگس، Nous Research کے
> [Hermes Agent](https://github.com/NousResearch/hermes-agent) سے اخذ کیا گیا ہے۔
> اصل کاپی رائٹ نوٹس اور [MIT لائسنس](LICENSE) محفوظ رکھے گئے ہیں۔

## اہم خصوصیات

- `query_multimodal` کے ذریعے موجودہ اور پچھلے مناظر پر سوال جواب۔
- `set_monitor` کے ذریعے مسلسل واقعہ مانیٹرنگ۔
- `set_live_watcher` کے ذریعے طویل ویڈیو تحقیق۔
- ویب اور ڈیسک ٹاپ میں اسکرین، کیمرہ، مائیکروفون اور شیئرڈ آڈیو کیپچر۔
- مناظر، آواز، واقعات اور اشخاص کے لیے ملٹی موڈل میموری۔

## PyPI سے انسٹال کریں

<div dir="ltr">

```bash
python -m pip install "mm-argus[web]"
argus setup
argus
```

</div>

PyPI پیکیج کا نام `mm-argus` اور بنیادی کمانڈ `argus` ہے۔

## سورس سے انسٹال کریں

<div dir="ltr">

```bash
git clone https://github.com/MMArgus-Team/Argus.git
cd argus
uv venv --python 3.11 .venv
source .venv/bin/activate
uv pip install -e ".[web]"
```

</div>

## کنفیگریشن

<div dir="ltr">

```bash
mkdir -p ~/.argus
cp config.example.yaml ~/.argus/config.yaml
cp .env.example ~/.argus/.env
argus setup
```

</div>

`config.yaml` میں رویّے، ماڈل اور endpoint کی ترتیبات ہوتی ہیں؛ `.env` میں صرف
API keys، tokens اور passwords رکھیں۔ حقیقی credentials کبھی repository میں
شائع نہ کریں۔

## روابط

- [دستاویزات](website/docs)
- [مسائل](https://github.com/MMArgus-Team/Argus/issues)
- [سیکیورٹی پالیسی](SECURITY.md)
- [تعاون](CONTRIBUTING.md)

## لائسنس

آرگس MIT لائسنس کے تحت جاری کیا جاتا ہے اور Hermes Agent اور Nous Research کی
اصل نسبت اور کاپی رائٹ نوٹس محفوظ رکھتا ہے۔ تفصیل کے لیے [LICENSE](LICENSE) دیکھیں۔

</div>
