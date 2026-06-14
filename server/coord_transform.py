from pyproj import Transformer

# All transformers use always_xy=True: input order is (lon, lat), output is (x, y)

wgs84_to_lv95    = Transformer.from_crs("EPSG:4326", "EPSG:2056",  always_xy=True)  # Switzerland
wgs84_to_rd      = Transformer.from_crs("EPSG:4326", "EPSG:28992", always_xy=True)  # Netherlands
wgs84_to_utm33   = Transformer.from_crs("EPSG:4326", "EPSG:25833", always_xy=True)  # Norway
wgs84_to_tm35    = Transformer.from_crs("EPSG:4326", "EPSG:3067",  always_xy=True)  # Finland
wgs84_to_lest    = Transformer.from_crs("EPSG:4326", "EPSG:3301",  always_xy=True)  # Estonia
wgs84_to_utm32   = Transformer.from_crs("EPSG:4326", "EPSG:25832", always_xy=True)  # Denmark
wgs84_to_d96tm   = Transformer.from_crs("EPSG:4326", "EPSG:3794",  always_xy=True)  # Slovenia D96/TM
