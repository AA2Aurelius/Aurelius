-- A still frame for each video, shown on video cards so they look ready to
-- play (iPhones won't load video to capture one without a tap). Made from
-- the source file by `npm run package-video` (or --posters for videos
-- already uploaded) and stored in R2 at posters/<video id>.jpg.
ALTER TABLE videos ADD COLUMN poster_r2_key TEXT;
ALTER TABLE evergreen_videos ADD COLUMN poster_r2_key TEXT;
