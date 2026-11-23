from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET

p = Path(__file__).parent / 'output/test.xlsx'
ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'r': 'http://schemas.openxmlformats.org/package/2006/relationships'}
with ZipFile(p) as z:
    assert z.testzip() is None
    for name in z.namelist(): ET.fromstring(z.read(name))
    sheet = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
    cells = {c.attrib['r']: c for c in sheet.findall('.//m:c', ns)}
    assert cells['B2'].find('m:v', ns).text == '100000'
    assert cells['B3'].find('m:v', ns).text == '0'
    assert cells['A2'].attrib['t'] == 'inlineStr'
    assert cells['A2'].find('.//m:t', ns).text == '=HYPERLINK("bad") <&>.pdf'
    assert not sheet.findall('.//m:f', ns), 'User data must never become Excel formulas'
    assert cells['K2'].find('.//m:t', ns).text == '9000000000000000347;0;1'
    rel = ET.fromstring(z.read('xl/worksheets/_rels/sheet1.xml.rels'))
    assert '9000000000000000347' in list(rel)[0].attrib['Target']
    assert list(rel)[0].attrib['TargetMode'] == 'External'
    workbook = ET.fromstring(z.read('xl/workbook.xml'))
    assert [s.attrib['name'] for s in workbook.findall('m:sheets/m:sheet', ns)] == ['Вложения','О сборе','Журнал']
print('ZIP CRC, OOXML, numeric sizes, long IDs, hyperlink and formula safety: PASS')
