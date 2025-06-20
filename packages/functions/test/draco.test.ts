import { Document } from '@gltf-transform/core';
import { draco } from '@gltf-transform/functions';
import { logger } from '@gltf-transform/test-utils';
import test from 'ava';

test('basic', async (t) => {
	const document = new Document().setLogger(logger);
	await document.transform(draco({ method: 'edgebreaker' }));
	await document.transform(draco({ method: 'sequential' }));
	const dracoExtension = document.getRoot().listExtensionsUsed()[0];
	t.is(dracoExtension.extensionName, 'KHR_draco_mesh_compression', 'adds extension');
});
