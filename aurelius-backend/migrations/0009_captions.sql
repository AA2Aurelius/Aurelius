-- Captions (WebVTT) for every video, loaded with `npm run captions`.
-- Small text files, so they live next to the video's row and are served
-- behind the same access checks as the video itself.
ALTER TABLE videos ADD COLUMN captions_vtt TEXT;
ALTER TABLE evergreen_videos ADD COLUMN captions_vtt TEXT;
