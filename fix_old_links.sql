-- CLEANUP OLD PEDAGOGICAL LINKS
-- Run this if your materials are opening with 404 because of a redundant '/materials/' folder in the URL.

UPDATE pedagogical_materials 
SET file_url = REPLACE(file_url, '/materials/materials/', '/materials/')
WHERE file_url LIKE '%/materials/materials/%';

-- Also fix any legacy '/materials/books/' links if you moved the files to the root
-- UPDATE pedagogical_materials 
-- SET file_url = REPLACE(file_url, '/materials/books/', '/materials/')
-- WHERE file_url LIKE '%/materials/books/%';
