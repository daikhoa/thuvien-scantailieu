# SmartDoc 2015 sample fixtures

This directory contains 15 preview-size frames derived from the official SmartDoc 2015 Challenge 1 sample dataset. They are benchmark inputs only and are not shipped in the web application.

- Source: <https://doi.org/10.5281/zenodo.1230218>
- Dataset version: 1.0.0, published 2015-08-28
- License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- Source archive MD5: `1ee5b7c290d707bd51c59f0b1c1a36f5`
- Attribution: Jean-Christophe Burie, Joseph Chazalon, Mickaël Coustaty, Sébastien Eskenazi, Muhammad Muzzamil Luqman, Maroua Mehri, Nibal Nayef, Jean-Marc Ogier, Sophea Prum and Marçal Rusiñol, “ICDAR2015 Competition on Smartphone Document Capture and OCR”, ICDAR 2015.

The preparation script selects five evenly spaced accepted frames per sample video, resizes each frame to a maximum edge of 960 pixels, scales the official quadrilateral coordinates to the resulting image, and records SHA-256 hashes in strict manifests.

- `development`: datasheet and letter samples; may be used while adapting parameters.
- `holdout`: magazine sample; must not be inspected for tuning before development parameters are frozen.

To reproduce, download and extract only `sampleDataset.tar.gz` from the source into `tests/datasets/smartdoc15-sample`, verify the MD5 above, ensure `ffmpeg` and `ffprobe` are available, then run `npm run fixtures:smartdoc-sample`. The downloaded archive and videos are ignored to avoid retaining unnecessary 21 MB source data.
