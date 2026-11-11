# Ask

An I Ching oracle made of word vectors, live at **[bigthought.ai/ask](https://bigthought.ai/ask)**.

Your question's words become [GloVe](https://nlp.stanford.edu/projects/glove/) vectors, which are averaged. Each of the 64 hexagrams has a vector averaged from its keywords, and Ask answers with the hexagrams closest to your question. It uses the method of [AI-CHING](https://github.com/adicarlisle/AI-CHING), with a compact vocabulary (int8 vectors with one float32 scale per word) so the whole thing fits a tiny container. Questions aren't stored.

The page works without JavaScript, and the same URL answers in a terminal:

```sh
curl https://bigthought.ai/ask -d "should I move abroad"
curl --no-progress-meter -NT. https://bigthought.ai/ask   # live prompt: type a question, press Enter
```

## Run it

Node.js 24 or later, with no dependencies:

```sh
npm start   # http://localhost:8080/ask
npm test
```

To rebuild `data/` from the full GloVe file (glove.6B.300d.txt, about 1 GB): `npm run build:data -- /path/to/glove.6B.300d.txt`.

Or with Docker: `docker build -t ask . && docker run -p 8080:8080 ask`.

## Licence

The code is MIT licensed (see `LICENSE`). The word vectors in `data/` are derived from GloVe (Stanford NLP), which is under the Public Domain Dedication and License. Ask is for reflection and fun, not advice. The BigThought name and logo aren't covered by the licence.

This repository is a copy of the app's folder in bigthought.ai's main (private) repository, refreshed when the app changes.
