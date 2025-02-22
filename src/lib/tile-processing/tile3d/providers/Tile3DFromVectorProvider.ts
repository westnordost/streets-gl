import Tile3DFeatureCollection from "~/lib/tile-processing/tile3d/features/Tile3DFeatureCollection";
import CombinedVectorFeatureProvider from "~/lib/tile-processing/vector/providers/CombinedVectorFeatureProvider";
import Handler, {RequestedHeightParams} from "~/lib/tile-processing/tile3d/handlers/Handler";
import VectorNodeHandler from "~/lib/tile-processing/tile3d/handlers/VectorNodeHandler";
import VectorPolylineHandler from "~/lib/tile-processing/tile3d/handlers/VectorPolylineHandler";
import VectorAreaHandler from "~/lib/tile-processing/tile3d/handlers/VectorAreaHandler";
import VectorFeatureCollection from "~/lib/tile-processing/vector/features/VectorFeatureCollection";
import VectorNode from "~/lib/tile-processing/vector/features/VectorNode";
import Tile3DInstance from "~/lib/tile-processing/tile3d/features/Tile3DInstance";
import Tile3DProjectedGeometry from "~/lib/tile-processing/tile3d/features/Tile3DProjectedGeometry";
import Tile3DExtrudedGeometry from "~/lib/tile-processing/tile3d/features/Tile3DExtrudedGeometry";
import * as Simplify from "simplify-js";
import {applyMercatorFactorToExtrudedFeatures} from "~/lib/tile-processing/tile3d/utils";
import Tile3DHuggingGeometry from "~/lib/tile-processing/tile3d/features/Tile3DHuggingGeometry";
import RoadGraph from "~/lib/road-graph/RoadGraph";
import {VectorAreaRingType} from "~/lib/tile-processing/vector/features/VectorArea";
import Intersection from "~/lib/road-graph/Intersection";
import {FeatureProvider} from "~/lib/tile-processing/types";
import Utils from "~/app/Utils";
import Tile3DLabel from "~/lib/tile-processing/tile3d/features/Tile3DLabel";
import MathUtils from "~/lib/math/MathUtils";
import Road from "~/lib/road-graph/Road";
import {VectorAreaDescriptor} from "~/lib/tile-processing/vector/qualifiers/descriptors";
import PowerlineHandler from "~/lib/tile-processing/tile3d/handlers/PowerlineHandler";

export interface Tile3DProviderParams {
	overpassEndpoint: string;
	tileServerEndpoint: string;
	mapboxEndpointTemplate: string;
	mapboxAccessToken: string;
	useCachedTiles: boolean;
	heightPromise: (positions: Float64Array) => Promise<Float64Array>;
}

export default class Tile3DFromVectorProvider implements FeatureProvider<Tile3DFeatureCollection> {
	private readonly vectorProvider: CombinedVectorFeatureProvider;
	private readonly params: Tile3DProviderParams;

	public constructor(params: Tile3DProviderParams) {
		this.params = params;
		this.vectorProvider = new CombinedVectorFeatureProvider(params);
	}

	public async getCollection(
		{
			x,
			y,
			zoom
		}: {
			x: number;
			y: number;
			zoom: number;
		}
	): Promise<Tile3DFeatureCollection> {
		const vectorTile = await this.vectorProvider.getCollection({x, y, zoom});

		const handlers = Tile3DFromVectorProvider.createHandlersFromVectorFeatureCollection(vectorTile);

		Tile3DFromVectorProvider.updateFeaturesMercatorScale(handlers, x, y, zoom);
		await Tile3DFromVectorProvider.updateFeaturesHeight(handlers, this.params.heightPromise);
		Tile3DFromVectorProvider.addRoadGraphToHandlers(handlers);

		const collection = Tile3DFromVectorProvider.getFeaturesFromHandlers(handlers);

		applyMercatorFactorToExtrudedFeatures(collection.extruded, x, y, zoom);

		return collection;
	}

	private static createHandlersFromVectorFeatureCollection(collection: VectorFeatureCollection): Handler[] {
		const handlers: Handler[] = [];

		for (const feature of collection.nodes) {
			handlers.push(new VectorNodeHandler(feature));
		}

		for (const feature of collection.polylines) {
			handlers.push(new VectorPolylineHandler(feature));
		}

		for (const feature of collection.areas) {
			for (const ring of feature.rings) {
				ring.nodes = Tile3DFromVectorProvider.simplifyNodes(ring.nodes);
			}
			handlers.push(new VectorAreaHandler(feature));
		}

		handlers.push(new PowerlineHandler(collection));

		return handlers;
	}

	private static addRoadGraphToHandlers(handlers: Handler[]): void {
		const graph = new RoadGraph();
		const roadIntersectionMaterials = new Map<Road, VectorAreaDescriptor['intersectionMaterial']>();

		for (const handler of handlers) {
			handler.setRoadGraph(graph);

			if (handler instanceof VectorPolylineHandler) {
				const road = handler.getGraphRoad();

				if (road !== null) {
					roadIntersectionMaterials.set(road, handler.getIntersectionMaterial());
				}
			}
		}

		graph.initIntersections();
		this.addIntersectionPolygonsToHandlers(graph, handlers, roadIntersectionMaterials);
	}

	private static addIntersectionPolygonsToHandlers(
		graph: RoadGraph,
		handlers: Handler[],
		intersectionMaterials: Map<Road, VectorAreaDescriptor['intersectionMaterial']>
	): void {
		const intersectionPolygons = graph.buildIntersectionPolygons(0);

		for (const {intersection, polygon} of intersectionPolygons) {
			const material = this.getIntersectionMaterial(intersection, intersectionMaterials);

			if (material === null) {
				// Skip intersection if it has no material
				intersection.userData.skip = true;
				continue;
			}

			polygon.push(polygon[0]);
			polygon.reverse();

			handlers.push(new VectorAreaHandler({
				type: 'area',
				descriptor: {
					type: 'roadwayIntersection',
					intersectionMaterial: material
				},
				rings: [{
					nodes: polygon.map(p => {
						return {
							type: 'node',
							osmReference: null,
							descriptor: null,
							x: p.x,
							y: p.y,
							rotation: 0
						};
					}),
					type: VectorAreaRingType.Outer
				}],
				osmReference: null
			}));
		}
	}

	private static getIntersectionMaterial(
		intersection: Intersection,
		materialsMap: Map<Road, VectorAreaDescriptor['intersectionMaterial']>
	):
		VectorAreaDescriptor['intersectionMaterial'] | null
	{
		const frequencyTable: Record<VectorAreaDescriptor['intersectionMaterial'], number> = {
			asphalt: 0,
			concrete: 0,
			cobblestone: 0
		};
		let total: number = 0;

		for (const dir of intersection.directions) {
			const material = materialsMap.get(dir.road);

			if (material !== null) {
				++frequencyTable[material];
				++total;
			}
		}

		if (total < 3) {
			return null;
		}

		const sorted = Object.entries(frequencyTable).sort((a, b) => b[1] - a[1]);

		if (sorted[0][1] === 0) {
			return null;
		}

		return sorted[0][0] as VectorAreaDescriptor['intersectionMaterial'];
	}

	private static simplifyNodes(nodes: VectorNode[]): VectorNode[] {
		return <VectorNode[]>Simplify(nodes, 0.5, false);
	}

	private static getFeaturesFromHandlers(handlers: Handler[]): Tile3DFeatureCollection {
		const collection: Tile3DFeatureCollection = {
			extruded: [],
			projected: [],
			hugging: [],
			labels: [],
			instances: []
		};

		for (const handler of handlers) {
			const output = handler.getFeatures();

			if (output) {
				for (const feature of output) {
					if (feature === null) {
						continue;
					}

					switch (feature.type) {
						case 'instance':
							collection.instances.push(feature as Tile3DInstance);
							break;
						case 'projected':
							collection.projected.push(feature as Tile3DProjectedGeometry);
							break;
						case 'extruded':
							collection.extruded.push(feature as Tile3DExtrudedGeometry);
							break;
						case 'hugging':
							collection.hugging.push(feature as Tile3DHuggingGeometry);
							break;
						case 'label':
							collection.labels.push(feature as Tile3DLabel);
							break;
					}
				}
			}
		}

		return collection;
	}

	private static updateFeaturesMercatorScale(features: Handler[], x: number, y: number, zoom: number): void {
		const scale = MathUtils.getMercatorScaleFactorForTile(x, y, zoom);

		for (const feature of features) {
			feature.setMercatorScale(scale);
		}
	}

	private static async updateFeaturesHeight(
		features: Handler[],
		heightPromise: (positions: Float64Array) => Promise<Float64Array>
	): Promise<void> {
		const paramsList: RequestedHeightParams[] = [];

		for (const feature of features) {
			const params = feature.getRequestedHeightPositions();

			if (params) {
				paramsList.push(params);
			}
		}

		const positionArrays: Float64Array[] = [];
		const offsets: number[] = [];
		let currentOffset: number = 0;

		for (const params of paramsList) {
			currentOffset += params.positions.length / 2;
			offsets.push(currentOffset);
			positionArrays.push(params.positions);
		}

		const mergedPositions = Utils.mergeTypedArrays(Float64Array, positionArrays);
		const height = await heightPromise(mergedPositions);
		const parts = this.splitHeightArray(height, offsets);

		for (let i = 0; i < parts.length; i++) {
			paramsList[i].callback(parts[i]);
		}
	}

	private static splitHeightArray(array: Float64Array, offsets: number[]): Float64Array[] {
		const parts: Float64Array[] = [];
		let startIndex: number = 0;

		for (let i = 0; i < offsets.length; i++) {
			const endIndex = offsets[i];

			parts.push(array.slice(startIndex, endIndex));

			startIndex = endIndex;
		}

		return parts;
	}
}